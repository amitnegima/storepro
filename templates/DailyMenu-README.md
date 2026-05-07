# Today's Menu — canteen-style daily list

This optional feature adds a pinned **🍱 Today's Menu** panel above the regular menu on the storefront. It's meant for shops that have:

- a **permanent printed menu** (everyday items: momos, rolls, shakes, etc.)
- AND a **handwritten daily menu** that changes each day (lunch combos, today's specials, evening snacks)

## How to set it up

### 1. Turn the section on (Config tab)

Add these rows to your tenant sheet's **Config** tab:

| Key | Value | Notes |
|---|---|---|
| `DailyMenuEnabled` | `Y` | Master switch. Leave blank to hide the section. |
| `DailyMenuLabel` | `🍱 Today's Menu` | Optional. Customise to "Lunch Special", "आज का मेनू", etc. |

### 2. Add a `DailyMenu` tab

Create a new tab in the tenant sheet named exactly `DailyMenu` with these columns (header row first):

| Column | Required? | Example | Notes |
|---|---|---|---|
| `Name` | ✅ | `Saap Masala Combo` | The dish name shown to customer |
| `Section` | optional | `Lunch` | Groups items inside the panel ("Lunch", "Snacks", "Thali"…). Default: "Today" |
| `Veg` | optional | `Y` / `N` / `Both` | Drives the green/red dot. `Both` = combo offered as veg or chicken |
| `Price` | optional | `110` | Single price, or the **veg** price when Veg=Both |
| `PriceNonVeg` | optional | `130` | Only used when Veg=Both — the chicken/non-veg upgrade price |
| `Description` | optional | `Choley + Kulcha + Pickle` | Short helper line shown under the name |
| `Available` | optional | `Y` / `N` / `SoldOut` | Quick toggle without deleting the row. Default: Y |
| `TimeWindow` | optional | `11:00-15:00` | Hides the row outside this window. Use 24-hour. Blank = always |

### 3. Update each morning

Open the `DailyMenu` tab on your phone, change today's lunch rows, save. The storefront refreshes every 60 seconds, so customers see the new menu without reopening the page.

To take an item off temporarily (e.g. ran out of saap), set `Available=N`. Putting it back is a one-tap edit.

## Veg + Chicken pricing in one row

The shop board often writes `110/130` for combos that come both veg and chicken. Model that in **one row**:

```
Saap Masala Combo, Lunch, Both, 110, 130, Saap + roti/rice, Y, 11:00-15:00
```

When the customer taps **CHOOSE**, a small picker opens asking Veg ₹110 / Chicken ₹130 — same flow as the existing customization modal. They pick, it goes into cart.

## What it looks like

```
┌──────────────────────────────────────────┐
│ 🍱 Today's Menu          MON · 6 MAY    │
│ ──────────────────────────────────────── │
│  LUNCH                                    │
│  ● Saap Masala Combo      ₹110 / ₹130   │
│    Saap + roti/rice                      │
│                              [ CHOOSE ]   │
│  ● Choley Kulcha               ₹80      │
│                                  [ ADD ]  │
│  THALI                                    │
│  ● Veg Thali                  ₹150      │
│                                  [ ADD ]  │
└──────────────────────────────────────────┘
        (regular printed menu below)
```

## Example data

The included [`DailyMenu-template.csv`](DailyMenu-template.csv) has 12 rows transcribed from a real Delhi canteen — paste it into a fresh `DailyMenu` tab to see the panel in action.

## Notes

- Items added from the daily menu go through the **same cart and checkout** as regular dishes. The shopkeeper sees them in their dashboard with category `Today's Lunch` (or whichever Section name you used).
- Daily items don't appear in the normal category navigation — they only live in the pinned panel.
- The panel hides itself automatically when no rows pass the filters (e.g. before lunch hours and after dinner).
- This currently ships in `fastfood.html` only. If you'd like the same feature in `restaurant.html` / `dhaba.html` / `meatshop.html`, we copy the same pattern.
