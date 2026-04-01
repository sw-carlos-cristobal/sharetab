import { describe, test, expect } from "vitest";
import { simplifyDebts, computeBalances, type MemberBalance } from "./balance-calculator";

// ── simplifyDebts ──────────────────────────────────────────

describe("simplifyDebts", () => {
  test("returns empty array when all balances are zero", () => {
    const balances: MemberBalance[] = [
      { userId: "a", paid: 100, owes: 100, net: 0 },
      { userId: "b", paid: 50, owes: 50, net: 0 },
    ];
    expect(simplifyDebts(balances)).toEqual([]);
  });

  test("simple two-person debt", () => {
    const balances: MemberBalance[] = [
      { userId: "alice", paid: 1000, owes: 500, net: 500 },
      { userId: "bob", paid: 0, owes: 500, net: -500 },
    ];
    const debts = simplifyDebts(balances);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toEqual({ from: "bob", to: "alice", amount: 500 });
  });

  test("three-person debt simplifies to minimum transfers", () => {
    // Alice paid $90, split 3 ways ($30 each)
    // Alice net = 90 - 30 = +60 (owed $60)
    // Bob net = 0 - 30 = -30 (owes $30)
    // Charlie net = 0 - 30 = -30 (owes $30)
    const balances: MemberBalance[] = [
      { userId: "alice", paid: 9000, owes: 3000, net: 6000 },
      { userId: "bob", paid: 0, owes: 3000, net: -3000 },
      { userId: "charlie", paid: 0, owes: 3000, net: -3000 },
    ];
    const debts = simplifyDebts(balances);
    expect(debts).toHaveLength(2);

    const totalTransferred = debts.reduce((sum, d) => sum + d.amount, 0);
    expect(totalTransferred).toBe(6000);

    // Both Bob and Charlie should pay Alice
    for (const debt of debts) {
      expect(debt.to).toBe("alice");
      expect(debt.amount).toBe(3000);
    }
  });

  test("chain debt simplification (A owes B, B owes C → A owes C)", () => {
    // A net = -100, B net = 0, C net = +100
    // Should simplify to A → C directly
    const balances: MemberBalance[] = [
      { userId: "a", paid: 0, owes: 100, net: -100 },
      { userId: "b", paid: 100, owes: 100, net: 0 },
      { userId: "c", paid: 100, owes: 0, net: 100 },
    ];
    const debts = simplifyDebts(balances);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toEqual({ from: "a", to: "c", amount: 100 });
  });

  test("four people with complex debts", () => {
    // A: net +50, B: net +30, C: net -60, D: net -20
    const balances: MemberBalance[] = [
      { userId: "a", paid: 50, owes: 0, net: 50 },
      { userId: "b", paid: 30, owes: 0, net: 30 },
      { userId: "c", paid: 0, owes: 60, net: -60 },
      { userId: "d", paid: 0, owes: 20, net: -20 },
    ];
    const debts = simplifyDebts(balances);

    // Total credits = 80, total debts = 80
    const totalTransferred = debts.reduce((sum, d) => sum + d.amount, 0);
    expect(totalTransferred).toBe(80);

    // Every debt should flow from a debtor to a creditor
    for (const debt of debts) {
      expect(debt.amount).toBeGreaterThan(0);
    }
  });

  test("handles single person (no debts)", () => {
    const balances: MemberBalance[] = [
      { userId: "solo", paid: 100, owes: 100, net: 0 },
    ];
    expect(simplifyDebts(balances)).toEqual([]);
  });

  test("handles empty balances array", () => {
    expect(simplifyDebts([])).toEqual([]);
  });

  test("total debts equal total credits", () => {
    // Property: sum of all net balances should always be 0
    const balances: MemberBalance[] = [
      { userId: "a", paid: 200, owes: 50, net: 150 },
      { userId: "b", paid: 30, owes: 100, net: -70 },
      { userId: "c", paid: 10, owes: 40, net: -30 },
      { userId: "d", paid: 60, owes: 110, net: -50 },
    ];
    const debts = simplifyDebts(balances);

    // All debts flow from debtors → creditors
    const totalToCreditors = debts.reduce((sum, d) => sum + d.amount, 0);
    expect(totalToCreditors).toBe(150); // equals the one creditor's net
  });

  test("large group with many participants", () => {
    // 6 people, 3 creditors and 3 debtors
    const balances: MemberBalance[] = [
      { userId: "c1", paid: 0, owes: 0, net: 100 },
      { userId: "c2", paid: 0, owes: 0, net: 200 },
      { userId: "c3", paid: 0, owes: 0, net: 50 },
      { userId: "d1", paid: 0, owes: 0, net: -150 },
      { userId: "d2", paid: 0, owes: 0, net: -120 },
      { userId: "d3", paid: 0, owes: 0, net: -80 },
    ];
    const debts = simplifyDebts(balances);

    // Should produce at most 5 transfers (n-1 for n people with non-zero)
    expect(debts.length).toBeLessThanOrEqual(5);

    const totalTransferred = debts.reduce((sum, d) => sum + d.amount, 0);
    expect(totalTransferred).toBe(350); // total credits
  });
});

// ── computeBalances ────────────────────────────────────────

describe("computeBalances", () => {
  test("single expense split equally between two people", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 1000,
          shares: [
            { userId: "alice", amount: 500 },
            { userId: "bob", amount: 500 },
          ],
        },
      ],
      []
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;

    expect(alice.paid).toBe(1000);
    expect(alice.owes).toBe(500);
    expect(alice.net).toBe(500); // Alice is owed $5

    expect(bob.paid).toBe(0);
    expect(bob.owes).toBe(500);
    expect(bob.net).toBe(-500); // Bob owes $5
  });

  test("multiple expenses with different payers", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 6000, // Alice pays $60
          shares: [
            { userId: "alice", amount: 2000 },
            { userId: "bob", amount: 2000 },
            { userId: "charlie", amount: 2000 },
          ],
        },
        {
          paidById: "bob",
          amount: 3000, // Bob pays $30
          shares: [
            { userId: "alice", amount: 1000 },
            { userId: "bob", amount: 1000 },
            { userId: "charlie", amount: 1000 },
          ],
        },
      ],
      []
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;
    const charlie = balances.find((b) => b.userId === "charlie")!;

    // Alice: paid 6000, owes 2000+1000=3000, net=+3000
    expect(alice.net).toBe(3000);
    // Bob: paid 3000, owes 2000+1000=3000, net=0
    expect(bob.net).toBe(0);
    // Charlie: paid 0, owes 2000+1000=3000, net=-3000
    expect(charlie.net).toBe(-3000);
  });

  test("settlements reduce debts", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 1000,
          shares: [
            { userId: "alice", amount: 500 },
            { userId: "bob", amount: 500 },
          ],
        },
      ],
      [
        { fromId: "bob", toId: "alice", amount: 300 }, // Bob pays Alice $3
      ]
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;

    // Alice: paid 1000, owes 500+300(settlement received)=800, net=+200
    expect(alice.net).toBe(200);
    // Bob: paid 0+300(settlement sent), owes 500, net=-200
    expect(bob.net).toBe(-200);
  });

  test("full settlement zeroes out balances", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 1000,
          shares: [
            { userId: "alice", amount: 500 },
            { userId: "bob", amount: 500 },
          ],
        },
      ],
      [
        { fromId: "bob", toId: "alice", amount: 500 }, // Bob pays full share
      ]
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;

    expect(alice.net).toBe(0);
    expect(bob.net).toBe(0);
  });

  test("net balances always sum to zero", () => {
    const balances = computeBalances(
      [
        {
          paidById: "a",
          amount: 8547,
          shares: [
            { userId: "a", amount: 2849 },
            { userId: "b", amount: 2849 },
            { userId: "c", amount: 2849 },
          ],
        },
        {
          paidById: "b",
          amount: 12300,
          shares: [
            { userId: "a", amount: 4100 },
            { userId: "b", amount: 4100 },
            { userId: "c", amount: 4100 },
          ],
        },
        {
          paidById: "c",
          amount: 14250,
          shares: [
            { userId: "a", amount: 4750 },
            { userId: "b", amount: 4750 },
            { userId: "c", amount: 4750 },
          ],
        },
      ],
      []
    );

    const netSum = balances.reduce((sum, b) => sum + b.net, 0);
    expect(netSum).toBe(0);
  });

  test("empty expenses and settlements", () => {
    const balances = computeBalances([], []);
    expect(balances).toEqual([]);
  });

  test("settlement-only (no expenses)", () => {
    const balances = computeBalances(
      [],
      [{ fromId: "bob", toId: "alice", amount: 500 }]
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;

    // Settlement: Bob "paid" 500, Alice "owes" 500
    expect(bob.net).toBe(500);
    expect(alice.net).toBe(-500);
  });

  test("matches seed data scenario (Apartment group)", () => {
    // Reproduce the seed data from prisma/seed.ts
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 8547, // Groceries
          shares: [
            { userId: "alice", amount: 2849 },
            { userId: "bob", amount: 2849 },
            { userId: "charlie", amount: 2849 },
          ],
        },
        {
          paidById: "bob",
          amount: 12300, // Electric bill
          shares: [
            { userId: "alice", amount: 4100 },
            { userId: "bob", amount: 4100 },
            { userId: "charlie", amount: 4100 },
          ],
        },
        {
          paidById: "alice",
          amount: 7999, // Internet
          shares: [
            { userId: "alice", amount: 2667 },
            { userId: "bob", amount: 2666 },
            { userId: "charlie", amount: 2666 },
          ],
        },
        {
          paidById: "charlie",
          amount: 14250, // Dinner out
          shares: [
            { userId: "alice", amount: 4750 },
            { userId: "bob", amount: 4750 },
            { userId: "charlie", amount: 4750 },
          ],
        },
      ],
      []
    );

    const alice = balances.find((b) => b.userId === "alice")!;
    const bob = balances.find((b) => b.userId === "bob")!;
    const charlie = balances.find((b) => b.userId === "charlie")!;

    // Alice paid: 8547 + 7999 = 16546, owes: 2849 + 4100 + 2667 + 4750 = 14366
    expect(alice.paid).toBe(16546);
    expect(alice.owes).toBe(14366);
    expect(alice.net).toBe(2180); // Alice is owed $21.80

    // Bob paid: 12300, owes: 2849 + 4100 + 2666 + 4750 = 14365
    expect(bob.paid).toBe(12300);
    expect(bob.owes).toBe(14365);
    expect(bob.net).toBe(-2065); // Bob owes $20.65

    // Charlie paid: 14250, owes: 2849 + 4100 + 2666 + 4750 = 14365
    expect(charlie.paid).toBe(14250);
    expect(charlie.owes).toBe(14365);
    expect(charlie.net).toBe(-115); // Charlie owes $1.15

    // Verify simplified debts match what we saw in the UI
    const debts = simplifyDebts(balances);
    expect(debts).toHaveLength(2);

    const bobToAlice = debts.find((d) => d.from === "bob" && d.to === "alice");
    expect(bobToAlice).toBeDefined();
    expect(bobToAlice!.amount).toBe(2065); // $20.65

    const charlieToAlice = debts.find((d) => d.from === "charlie" && d.to === "alice");
    expect(charlieToAlice).toBeDefined();
    expect(charlieToAlice!.amount).toBe(115); // $1.15
  });
});

// ── Integration: computeBalances + simplifyDebts ───────────

describe("computeBalances + simplifyDebts integration", () => {
  test("complex scenario: 4 people, multiple expenses, partial settlement", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 10000, // Alice pays $100, split 4 ways
          shares: [
            { userId: "alice", amount: 2500 },
            { userId: "bob", amount: 2500 },
            { userId: "charlie", amount: 2500 },
            { userId: "dave", amount: 2500 },
          ],
        },
        {
          paidById: "bob",
          amount: 4000, // Bob pays $40, split between bob and charlie
          shares: [
            { userId: "bob", amount: 2000 },
            { userId: "charlie", amount: 2000 },
          ],
        },
      ],
      [
        { fromId: "charlie", toId: "alice", amount: 1000 }, // Charlie pays Alice $10
      ]
    );

    const debts = simplifyDebts(balances);

    // Total net should sum to 0
    const netSum = balances.reduce((sum, b) => sum + b.net, 0);
    expect(netSum).toBe(0);

    // All debt amounts should be positive
    for (const debt of debts) {
      expect(debt.amount).toBeGreaterThan(0);
    }

    // Total transferred should equal total positive net
    const totalCredits = balances.filter((b) => b.net > 0).reduce((sum, b) => sum + b.net, 0);
    const totalTransferred = debts.reduce((sum, d) => sum + d.amount, 0);
    expect(totalTransferred).toBe(totalCredits);
  });

  test("all-settled group produces no debts", () => {
    const balances = computeBalances(
      [
        {
          paidById: "alice",
          amount: 2000,
          shares: [
            { userId: "alice", amount: 1000 },
            { userId: "bob", amount: 1000 },
          ],
        },
      ],
      [{ fromId: "bob", toId: "alice", amount: 1000 }]
    );

    const debts = simplifyDebts(balances);
    expect(debts).toHaveLength(0);
  });
});
