import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("Seeding database...");

  // Create demo users
  const passwordHash = await bcrypt.hash("password123", 12);

  const alice = await prisma.user.upsert({
    where: { email: "alice@example.com" },
    update: {},
    create: {
      name: "Alice Johnson",
      email: "alice@example.com",
      passwordHash,
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: "bob@example.com" },
    update: {},
    create: {
      name: "Bob Smith",
      email: "bob@example.com",
      passwordHash,
    },
  });

  const charlie = await prisma.user.upsert({
    where: { email: "charlie@example.com" },
    update: {},
    create: {
      name: "Charlie Brown",
      email: "charlie@example.com",
      passwordHash,
    },
  });

  console.log("Created users: Alice, Bob, Charlie (password: password123)");

  // Create a demo group (skip if already exists)
  const existingApartment = await prisma.group.findFirst({
    where: { name: "Apartment", members: { some: { userId: alice.id } } },
  });
  if (existingApartment) {
    console.log("Seed data already exists, skipping.");
    return;
  }

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

  // Create demo expenses
  const expenses = [
    {
      title: "Groceries",
      amount: 8547, // $85.47
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
      amount: 12300, // $123.00
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
      amount: 7999, // $79.99
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
      amount: 14250, // $142.50
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
        shares: {
          create: exp.shares,
        },
      },
    });
  }

  console.log(`Created ${expenses.length} demo expenses`);

  // Create a trip group
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
      amount: 120000, // $1,200.00
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
      amount: 45000, // $450.00
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
