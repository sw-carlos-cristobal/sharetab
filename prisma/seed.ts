import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  const passwordHash = await bcrypt.hash("password123", 12);

  // ── Core demo users ─────────────────────────────────────
  const alice = await prisma.user.upsert({
    where: { email: "alice@example.com" },
    update: {},
    create: { name: "Alice Johnson", email: "alice@example.com", passwordHash },
  });

  const bob = await prisma.user.upsert({
    where: { email: "bob@example.com" },
    update: {},
    create: { name: "Bob Smith", email: "bob@example.com", passwordHash },
  });

  const charlie = await prisma.user.upsert({
    where: { email: "charlie@example.com" },
    update: {},
    create: { name: "Charlie Brown", email: "charlie@example.com", passwordHash },
  });

  // ── Dedicated test users (isolated from demo data) ──────
  // These exist solely for specific e2e test scenarios to avoid
  // collisions with demo users or other tests.

  const suspendUser = await prisma.user.upsert({
    where: { email: "suspend-test@example.com" },
    update: {},
    create: { name: "Suspend Test User", email: "suspend-test@example.com", passwordHash },
  });

  const deleteUser = await prisma.user.upsert({
    where: { email: "delete-test@example.com" },
    update: {},
    create: { name: "Delete Test User", email: "delete-test@example.com", passwordHash },
  });

  const pwUser = await prisma.user.upsert({
    where: { email: "pwtest@example.com" },
    update: {},
    create: { name: "Password Test User", email: "pwtest@example.com", passwordHash },
  });

  console.log("Created users: Alice, Bob, Charlie + 3 test users (password: password123)");

  // Check if seed data already exists
  const existingApartment = await prisma.group.findFirst({
    where: { name: "Apartment", members: { some: { userId: alice.id } } },
  });
  if (existingApartment) {
    console.log("Seed data already exists, skipping.");
    return;
  }

  // ── Demo group: Apartment ───────────────────────────────
  const group = await prisma.group.create({
    data: {
      name: "Apartment",
      description: "Monthly shared expenses",
      emoji: "🏠",
      currency: "USD",
      members: {
        create: [
          { userId: alice.id, role: "OWNER" },
          { userId: bob.id, role: "MEMBER" },
          { userId: charlie.id, role: "MEMBER" },
        ],
      },
    },
  });

  console.log(`Created group: ${group.name}`);

  // Demo expenses
  const expenses = [
    {
      title: "Groceries",
      amount: 8547,
      category: "Food",
      paidById: alice.id,
      shares: [
        { userId: alice.id, amount: 2849 },
        { userId: bob.id, amount: 2849 },
        { userId: charlie.id, amount: 2849 },
      ],
    },
    {
      title: "Electric bill",
      amount: 12300,
      category: "Utilities",
      paidById: bob.id,
      shares: [
        { userId: alice.id, amount: 4100 },
        { userId: bob.id, amount: 4100 },
        { userId: charlie.id, amount: 4100 },
      ],
    },
    {
      title: "Internet",
      amount: 7999,
      category: "Utilities",
      paidById: alice.id,
      shares: [
        { userId: alice.id, amount: 2667 },
        { userId: bob.id, amount: 2666 },
        { userId: charlie.id, amount: 2666 },
      ],
    },
    {
      title: "Dinner out",
      amount: 14250,
      category: "Food",
      paidById: charlie.id,
      shares: [
        { userId: alice.id, amount: 4750 },
        { userId: bob.id, amount: 4750 },
        { userId: charlie.id, amount: 4750 },
      ],
    },
  ];

  for (const exp of expenses) {
    await prisma.expense.create({
      data: {
        groupId: group.id,
        title: exp.title,
        amount: exp.amount,
        category: exp.category,
        paidById: exp.paidById,
        addedById: exp.paidById,
        splitMode: "EQUAL",
        shares: { create: exp.shares },
      },
    });
  }

  console.log(`Created ${expenses.length} demo expenses`);

  // ── Demo group: Japan Trip ──────────────────────────────
  const trip = await prisma.group.create({
    data: {
      name: "Japan Trip",
      description: "Vacation expenses",
      emoji: "✈️",
      currency: "USD",
      members: {
        create: [
          { userId: alice.id, role: "OWNER" },
          { userId: bob.id, role: "MEMBER" },
        ],
      },
    },
  });

  await prisma.expense.create({
    data: {
      groupId: trip.id,
      title: "Flight tickets",
      amount: 120000,
      category: "Transport",
      paidById: alice.id,
      addedById: alice.id,
      splitMode: "EQUAL",
      shares: {
        create: [
          { userId: alice.id, amount: 60000 },
          { userId: bob.id, amount: 60000 },
        ],
      },
    },
  });

  await prisma.expense.create({
    data: {
      groupId: trip.id,
      title: "Hotel (3 nights)",
      amount: 45000,
      category: "Accommodation",
      paidById: bob.id,
      addedById: bob.id,
      splitMode: "EQUAL",
      shares: {
        create: [
          { userId: alice.id, amount: 22500 },
          { userId: bob.id, amount: 22500 },
        ],
      },
    },
  });

  console.log(`Created group: ${trip.name} with 2 expenses`);

  // ── Test group: for admin suspend/delete tests ──────────
  // The suspend-test and delete-test users need to be in at least
  // one group so they appear in admin user management with group counts.
  const testGroup = await prisma.group.create({
    data: {
      name: "Test Admin Group",
      description: "For e2e admin tests",
      emoji: "🧪",
      currency: "USD",
      members: {
        create: [
          { userId: alice.id, role: "OWNER" },
          { userId: suspendUser.id, role: "MEMBER" },
          { userId: deleteUser.id, role: "MEMBER" },
        ],
      },
    },
  });

  console.log(`Created group: ${testGroup.name} (admin test fixtures)`);
  console.log("\nSeed complete! Login with any user email and password: password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
