# Splitit — Functional Test Cases

## 1. Authentication

### 1.1 Registration
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 1.1.1 | Register new user | POST `auth.register` with `{ name: "Test", email: "test@test.com", password: "pass123" }` | User created, returns `{ id, name, email }` |
| 1.1.2 | Register duplicate email | Register same email twice | Second attempt returns CONFLICT error |
| 1.1.3 | Register with short password | Register with password "abc" (< 6 chars) | Validation error |
| 1.1.4 | Register with invalid email | Register with email "not-an-email" | Validation error |

### 1.2 Login
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 1.2.1 | Login with valid credentials | signIn("credentials", { email, password }) | Session created, redirect to /dashboard |
| 1.2.2 | Login with wrong password | signIn with incorrect password | Returns error, stays on /login |
| 1.2.3 | Login with non-existent email | signIn with unknown email | Returns error "Invalid email or password" |
| 1.2.4 | Login with OAuth-only user | Register via Google, try password login | Returns error (no passwordHash) |

### 1.3 Session & Middleware
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 1.3.1 | Access dashboard without auth | Navigate to /dashboard without session cookie | Redirect to /login?callbackUrl=/dashboard |
| 1.3.2 | Access groups without auth | Navigate to /groups/... without session cookie | Redirect to /login |
| 1.3.3 | Access login while authenticated | Navigate to /login with valid session | Page renders (no forced redirect) |
| 1.3.4 | Session token in cookie | After login, check cookies | `authjs.session-token` cookie present |

---

## 2. Groups

### 2.1 Create Group
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 2.1.1 | Create group with defaults | `groups.create({ name: "Test" })` | Group created with USD currency, creator is OWNER |
| 2.1.2 | Create group with all fields | `groups.create({ name: "Trip", description: "Vacation", currency: "EUR", emoji: "✈️" })` | Group created with all fields set |
| 2.1.3 | Create group without auth | Call `groups.create` without session | UNAUTHORIZED error |
| 2.1.4 | Create group with empty name | `groups.create({ name: "" })` | Validation error |

### 2.2 Group Membership
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 2.2.1 | List user's groups | `groups.list()` as a user with 2 groups | Returns 2 groups with members and expense counts |
| 2.2.2 | Get group as member | `groups.get({ groupId })` as a member | Returns group with member details |
| 2.2.3 | Get group as non-member | `groups.get({ groupId })` as non-member | FORBIDDEN error |
| 2.2.4 | Remove self from group | `groups.removeMember({ groupId, userId: self })` | Member removed, MEMBER_LEFT activity logged |
| 2.2.5 | Admin removes member | Owner calls `groups.removeMember` for a MEMBER | Member removed |
| 2.2.6 | Member tries to remove another | MEMBER tries to remove another MEMBER | FORBIDDEN error |
| 2.2.7 | Remove the owner | Admin tries to remove the OWNER | FORBIDDEN error |

### 2.3 Group Settings
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 2.3.1 | Owner updates group | `groups.update({ groupId, name: "New Name" })` as OWNER | Group name updated |
| 2.3.2 | Member tries update | `groups.update(...)` as MEMBER | FORBIDDEN error |
| 2.3.3 | Owner deletes group | `groups.delete({ groupId })` as OWNER | Group and all data deleted |
| 2.3.4 | Non-owner deletes group | `groups.delete(...)` as MEMBER or ADMIN | FORBIDDEN error |

### 2.4 Invites
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 2.4.1 | Generate invite link | `groups.createInvite({ groupId })` | Returns `{ token }`, invite expires in 7 days |
| 2.4.2 | Join via valid invite | `groups.joinByInvite({ token })` as new user | User added to group, MEMBER_JOINED logged |
| 2.4.3 | Join via expired invite | Use an invite with `expiresAt` in the past | NOT_FOUND error |
| 2.4.4 | Join via used invite | Use an invite that was already used | NOT_FOUND error |
| 2.4.5 | Join group already a member of | `joinByInvite` for a group user is already in | Returns `{ alreadyMember: true }`, no duplicate membership |
| 2.4.6 | Join invite without auth | `joinByInvite` without session | UNAUTHORIZED error |

---

## 3. Expenses

### 3.1 Create Expense
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 3.1.1 | Create equal split | 3 members, $30 total, EQUAL mode | Each member gets $10.00 share |
| 3.1.2 | Create equal split with remainder | 3 members, $10 total (1000 cents), EQUAL | Two get 334, one gets 332 (total = 1000) |
| 3.1.3 | Create exact split | Shares: Alice $20, Bob $10 | Exact amounts stored on ExpenseShare |
| 3.1.4 | Create percentage split | Alice 60%, Bob 40% of $100 | Alice: $60, Bob: $40 |
| 3.1.5 | Create shares split | Alice 2 shares, Bob 1 share of $90 | Alice: $60, Bob: $30 |
| 3.1.6 | Shares sum mismatch | Shares sum to $25 but amount is $30 | BAD_REQUEST error |
| 3.1.7 | Create expense as non-member | Call `expenses.create` for a group you're not in | FORBIDDEN error |
| 3.1.8 | Activity log created | Create an expense | EXPENSE_CREATED activity with title and amount in metadata |

### 3.2 Expense CRUD
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 3.2.1 | List expenses paginated | Create 25 expenses, list with limit=10 | Returns 10 expenses + nextCursor |
| 3.2.2 | List with cursor | Use nextCursor from previous call | Returns next page of results |
| 3.2.3 | Get expense detail | `expenses.get({ groupId, expenseId })` | Returns expense with paidBy, addedBy, shares, receipt |
| 3.2.4 | Get expense from wrong group | Use valid expenseId but wrong groupId | NOT_FOUND error |
| 3.2.5 | Update expense | Change title and amount | Updated values persisted, EXPENSE_UPDATED logged |
| 3.2.6 | Delete expense | `expenses.delete({ groupId, expenseId })` | Expense deleted, EXPENSE_DELETED logged |
| 3.2.7 | Expenses ordered by date | List expenses | Most recent expenseDate first |

---

## 4. Balances & Settlements

### 4.1 Balance Calculation
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 4.1.1 | Single expense balance | Alice pays $30, split equally among Alice+Bob+Charlie | Alice: net +$20, Bob: net -$10, Charlie: net -$10 |
| 4.1.2 | Multiple payers | Alice pays $30 equal, Bob pays $60 equal (3 members) | Alice: net +$10, Bob: net +$40, Charlie: net -$50... verify actual math |
| 4.1.3 | Zero balance | Only one member, pays $50 for themselves | net = 0 |
| 4.1.4 | Settlement affects balance | After Bob settles $10 to Alice | Bob's paid += 10, Alice's owes += 10, net adjusts |
| 4.1.5 | Empty group | Group with no expenses or settlements | All balances are 0 |

### 4.2 Debt Simplification
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 4.2.1 | Simple two-person | Alice net +$20, Bob net -$20 | One debt: Bob → Alice $20 |
| 4.2.2 | Three-person chain | Alice: +$30, Bob: -$10, Charlie: -$20 | Two debts: Charlie→Alice $20, Bob→Alice $10 |
| 4.2.3 | Circular debts | Alice owes Bob $10, Bob owes Charlie $10, Charlie owes Alice $10 | All cancel out, no debts |
| 4.2.4 | Already settled | All net balances = 0 | Empty debts array |
| 4.2.5 | Greedy matching | A: +50, B: +30, C: -40, D: -40 | Minimal transactions (3 or fewer) |

### 4.3 Dashboard
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 4.3.1 | Cross-group totals | User in 2 groups, owed in one, owes in another | totalOwed and totalOwing calculated independently |
| 4.3.2 | Per-group breakdown | User in 3 groups | perGroup array has 3 entries with correct balances |
| 4.3.3 | New user dashboard | User with no groups | totalOwed=0, totalOwing=0, perGroup=[] |

### 4.4 Settlements
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 4.4.1 | Record settlement | Bob settles $20 to Alice | Settlement created, SETTLEMENT_CREATED logged |
| 4.4.2 | Settlement updates balance | After settlement, check balances | Bob's net increases by $20, Alice's net decreases by $20 |
| 4.4.3 | Full settlement | Settle exact debt amount | Simplified debts returns empty after settling all |
| 4.4.4 | Partial settlement | Settle less than owed | Remaining debt shows in simplified debts |

---

## 5. Receipt Scanning & Item Splitting

### 5.1 Upload
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 5.1.1 | Upload valid JPEG | POST /api/upload with JPEG file | Returns `{ receiptId, imagePath }`, Receipt status=PENDING |
| 5.1.2 | Upload valid PNG | POST /api/upload with PNG file | Success |
| 5.1.3 | Upload invalid type | POST /api/upload with PDF file | 400 error "Invalid file type" |
| 5.1.4 | Upload too large | POST file exceeding MAX_UPLOAD_SIZE_MB | 400 error "File too large" |
| 5.1.5 | Upload without auth | POST /api/upload without session | 401 Unauthorized |
| 5.1.6 | Upload no file | POST /api/upload with empty form | 400 "No file provided" |

### 5.2 AI Processing
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 5.2.1 | Process receipt (success) | `receipts.processReceipt({ receiptId })` with valid image | Status → COMPLETED, ReceiptItems created, extractedData stored |
| 5.2.2 | Process receipt (AI failure) | Process with invalid/corrupt image | Status → FAILED, error stored in rawResponse |
| 5.2.3 | Retry processing | After failure, `receipts.retryProcessing` then re-process | Old items deleted, receipt reset to PENDING, can process again |
| 5.2.4 | Get receipt items | After successful processing | Returns items ordered by sortOrder with amounts in cents |
| 5.2.5 | OpenAI provider | Set AI_PROVIDER=openai with valid key | Extracts items using GPT-4o vision |
| 5.2.6 | Claude provider | Set AI_PROVIDER=claude with valid key | Extracts items using Claude Sonnet |
| 5.2.7 | Ollama provider | Set AI_PROVIDER=ollama with local server | Extracts items using llava model |
| 5.2.8 | Invalid provider | Set AI_PROVIDER=invalid | Error: "Unknown AI provider" |

### 5.3 Item Assignment & Expense Creation
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 5.3.1 | Assign all items to one person | All items → Alice | Alice's total = subtotal + tax + tip |
| 5.3.2 | Split items between two | Item A ($10) → Alice, Item B ($20) → Bob, tax=$3, tip=$0 | Alice: $11 (10 + 1 tax), Bob: $22 (20 + 2 tax) |
| 5.3.3 | Share single item | One $12 item → Alice+Bob | Each gets $6 from item, proportional tax/tip |
| 5.3.4 | Tip override | AI detects tip=$0, user sets tipOverride=$500 | Tip distributed proportionally, total includes $5 tip |
| 5.3.5 | Remainder correction | 3 users split $10 item → $3.33 each | Two get $3.34, one gets $3.32 (total = $10.00) |
| 5.3.6 | Tax proportional distribution | Subtotal=$100, tax=$8. Alice items=$60, Bob items=$40 | Alice tax: $4.80, Bob tax: $3.20 |
| 5.3.7 | Creates ITEM expense | Complete assignment flow | Expense with splitMode=ITEM, correct total, shares match |
| 5.3.8 | Activity log from receipt | Create expense from receipt | EXPENSE_CREATED with `{ fromReceipt: true }` in metadata |
| 5.3.9 | Receipt not ready | Try to assign on PENDING receipt | BAD_REQUEST error |

---

## 6. Image Serving

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 6.1 | Serve uploaded image | GET /api/uploads/receipts/abc.jpg (authenticated) | Returns image with correct Content-Type |
| 6.2 | Path traversal blocked | GET /api/uploads/../../../etc/passwd | 403 Forbidden |
| 6.3 | Non-existent file | GET /api/uploads/receipts/nonexistent.jpg | 404 Not found |
| 6.4 | Without auth | GET /api/uploads/... without session | 401 Unauthorized |
| 6.5 | Cache headers | Successful image retrieval | `Cache-Control: private, max-age=86400` |

---

## 7. UI Functional Tests

### 7.1 Login Flow
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.1.1 | Successful login | Enter email+password, click Sign in | Redirect to /dashboard, sidebar shows user name |
| 7.1.2 | Failed login | Enter wrong password, click Sign in | Error message "Invalid email or password" |
| 7.1.3 | Navigate to register | Click "Create one" link | Navigate to /register page |
| 7.1.4 | Register and auto-login | Fill register form, submit | Account created, auto-signed in, redirect to dashboard |

### 7.2 Dashboard
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.2.1 | Balance cards | Login as user with expenses | "You are owed" (green) and "You owe" (red) show correct amounts |
| 7.2.2 | Group list | User in multiple groups | Each group card shows emoji, name, member count, balance |
| 7.2.3 | Empty state | New user with no groups | "No groups yet" message with "Create Group" button |
| 7.2.4 | Click group card | Click a group card | Navigate to /groups/[groupId] |

### 7.3 Group Detail
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.3.1 | Member chips | View group with 3 members | Avatar chips for each member, Owner badge on owner |
| 7.3.2 | Balances card | Group with debts | Simplified debts shown: "A → B: $X.XX" |
| 7.3.3 | Settled up state | Group with zero balances | "All settled up!" message |
| 7.3.4 | Click debt row | Click a debt in the balances card | Settle dialog opens pre-filled with from/to/amount |
| 7.3.5 | Settle up button | Click "Settle up" button | Settle dialog opens (empty form) |
| 7.3.6 | Expense list | Group with expenses | Expenses listed with title, paidBy, date, amount |
| 7.3.7 | Add Expense button | Click "+ Add Expense" | Navigate to /groups/[groupId]/expenses/new |
| 7.3.8 | Scan Receipt button | Click "Scan Receipt" | Navigate to /groups/[groupId]/scan |

### 7.4 Expense Creation
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.4.1 | Equal split UI | Select EQUAL, check/uncheck members | Per-person amount updates live |
| 7.4.2 | Exact split UI | Select EXACT, enter amounts per person | Shows remaining/over-allocated status |
| 7.4.3 | Percentage split UI | Select PERCENTAGE, enter percentages | Shows dollar amount per person, warns if != 100% |
| 7.4.4 | Shares split UI | Select SHARES, enter share units | Shows calculated amount per person |
| 7.4.5 | Submit expense | Fill all fields, click "Add Expense" | Expense created, redirect to group detail |

### 7.5 Receipt Scanning
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.5.1 | Upload step | Choose image file | File uploads, transitions to "Processing..." |
| 7.5.2 | Processing step | After upload | Spinner shown, AI processes image |
| 7.5.3 | Assignment step | After processing succeeds | Items listed with member toggle buttons |
| 7.5.4 | Toggle member on item | Click a member button on an item | Button highlights, per-person totals update |
| 7.5.5 | Split all equally | Click "Split all equally" | All items assigned to all members |
| 7.5.6 | Tip override | Enter a new tip amount | Per-person totals adjust |
| 7.5.7 | Submit receipt expense | Assign all items, click "Create Expense" | Expense created with ITEM mode, redirect to group |
| 7.5.8 | Error + retry | AI fails (bad image) | Error shown with "Try again" and "Retry processing" buttons |

### 7.6 Mobile Responsive
| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.6.1 | Sidebar hidden on mobile | View at < 768px width | Desktop sidebar hidden, hamburger menu visible |
| 7.6.2 | Mobile menu | Tap hamburger icon | Sheet opens with navigation links |
| 7.6.3 | Mobile menu navigation | Tap "Groups" in mobile menu | Navigate to /groups, menu closes |
| 7.6.4 | Mobile sign out | Tap "Sign out" in mobile menu | Signed out, redirect to /login |

---

## 8. API Health & Infrastructure

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 8.1 | Health check (healthy) | GET /api/health with DB running | `{ status: "ok", db: "connected" }` with 200 |
| 8.2 | Health check (db down) | GET /api/health with DB offline | `{ status: "error", db: "disconnected" }` with 503 |
| 8.3 | PWA manifest | GET /manifest.json | Valid manifest with name "Splitit", icons, start_url |
| 8.4 | PWA icons | GET /icons/icon-192.png and /icons/icon-512.png | Valid PNG images at correct sizes |

---

## 9. Edge Cases & Security

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 9.1 | Money stored as cents | Create $12.99 expense | amount=1299 in database |
| 9.2 | Large amount | Create $100,000.00 expense | amount=10000000, no overflow |
| 9.3 | Zero amount expense | Create expense with amount=0 | Validation error (amount must be positive) |
| 9.4 | Empty shares array | Create expense with shares=[] | Validation error (min 1 share) |
| 9.5 | XSS in group name | Create group with name `<script>alert(1)</script>` | Rendered as text, not executed |
| 9.6 | SQL injection in search | Pass `'; DROP TABLE "User";--` as group name | Prisma parameterizes, no injection |
| 9.7 | Concurrent settlements | Two users settle simultaneously | Both succeed, no double-counting |
| 9.8 | Upload path traversal | Upload file with name `../../etc/passwd.jpg` | UUID filename generated, original name ignored for storage |
