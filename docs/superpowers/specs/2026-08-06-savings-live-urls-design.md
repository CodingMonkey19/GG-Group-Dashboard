# Savings and Live URLs Dashboard Design

## Goal

Give the CEO a clear, professional view of link-level savings and make the Live URLs view operationally useful without exposing technical implementation fields.

## Source of truth

Use the existing `Clean Data` tab from spreadsheet `19J-aZhf3fsEasUSRl9c1rXPr4nF6e63XsYI4VgNVrGg`. The dashboard must read the supplied reporting Month, Order, Target URL, Anchor, Website, Live URL, Price (EUR), PressWhizz Price (EUR), Saving (EUR), and Invoice Date. It must not estimate or recalculate source prices or savings. January and LiveSportsOdds remain excluded.

## Navigation and global filters

The main view toggle becomes **Spend**, **Savings**, and **Live URLs**. Month and Order remain global filters and apply to all three tabs. Comparison remains available for Spend and Savings and is hidden for Live URLs. The February–December scope control remains available for Spend and Savings.

## Savings tab

The Savings tab is summary-first and link-level:

- Hero cards: Total Saved, PressWhizz Equivalent, Our Spend, and Savings Rate.
- Savings Rate is `total supplied Saving / total supplied PressWhizz Price`, using source-supplied amounts.
- Charts: savings by reporting month and savings by order, using the active Month, Order, scope, and comparison controls.
- Detail table: one completed link per row with Website, PressWhizz Price, Our Price, Saved, Saving %, and Live URL.
- Positive savings use restrained green emphasis. Negative or zero savings remain visible with neutral/warning treatment.

## Live URLs tab

Replace the current per-publisher/history table with one completed-link row per record. Columns appear in this exact order:

1. Target URL
2. Anchor Text
3. Website
4. Live URL
5. Price
6. Date

The global Month and Order filters scope the page. Column search/range controls cover URLs, anchor, website, price, and date. Each safe HTTP(S) Target URL and Live URL opens in a new tab.

## CEO detail cards

Remove ECB Rate, Artifact, Sheet, and Source Row Key from drill-down cards. Display Live Link and Anchor Text instead. Keep the directly useful business fields: order, website, price, savings, and date.

## Data and API changes

Carry Target URL, Anchor, and PressWhizz Price from `Clean Data` through ingestion, normalized storage, API contracts, and frontend selectors. Existing snapshots that lack these fields are incompatible and must be replaced by a successful refresh before the new frontend is considered ready.

## Empty and partial data

- A missing PressWhizz Price remains blank; do not invent one.
- Saving % remains blank when PressWhizz Price is missing or zero.
- Rows missing a Live URL do not appear in Live URLs, but can remain visible in Savings when the source has savings data.
- Existing refresh errors remain visible without replacing the last successful snapshot.

## Acceptance criteria

- Savings totals reconcile exactly to the filtered source rows.
- Savings contains one row per completed link and respects Month, Order, scope, and comparison.
- Live URLs uses the required six columns and respects Month and Order.
- No CEO-facing card shows ECB Rate, Artifact, Sheet, or Source Row Key.
- Drill-down cards show Live Link and Anchor Text.
- January and LiveSportsOdds remain absent.
- The deployed dashboard refreshes successfully from the designated source sheet.
