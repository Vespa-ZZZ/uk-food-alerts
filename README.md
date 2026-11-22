# UK Food Alerts (FSA)

Collect Allergy Alerts (AA), Product Recall Information Notices (PRIN), and Food Alerts for Action (FAFA) from the UK Food Standards Agency. Use the results to screen inventory against FSA product and lot details, follow a specific allergen, or send new and revised notices to a review queue.

## Input

| Field | Default | How it works |
| --- | --- | --- |
| `alertTypes` | All three types | Choose any combination of `AA`, `PRIN`, and `FAFA`. |
| `allergens` | All alerts | Match any exact FSA allergen label, notation, or published alternative label, ignoring case. |
| `since` | Unset | Include alerts modified on or after this UTC date in `YYYY-MM-DD` format. Takes precedence over `daysBack`. |
| `daysBack` | `30` | Include alerts modified in the last N days when `since` is unset. |
| `keywords` | All titles | Match any title substring, ignoring case. |
| `onlyNew` | `false` | Emit each matching combination of alert ID, last-modified timestamp and status once per monitoring key. |
| `stateKey` | `default` | Use the same key for successive runs and a different key for each independent monitor. Use 1–50 letters, digits, underscores or hyphens. |

Find recent allergy alerts for milk or peanuts with “chocolate” in the title.

```json
{
  "alertTypes": ["AA"],
  "allergens": ["milk", "peanuts"],
  "keywords": ["chocolate"],
  "daysBack": 30
}
```

Track new and revised alerts, including withdrawals, with the same input on every scheduled run.

```json
{
  "onlyNew": true,
  "stateKey": "stock-review",
  "daysBack": 30
}
```

The first monitoring run emits the matching alerts in the current window. Later runs emit each version once, including a changed status with the same timestamp if the alert remains in the window. Follow-up notices with their own FSA identifier appear as separate alerts. Use one schedule per state key and avoid overlapping runs sharing that key.

Monitoring saves state after each successful dataset write. If a pay-per-event limit stops a write, the unsaved version stays eligible while it remains in the date window. Widen the window with `since` to catch up after a missed run. Dataset writes and state updates are separate operations, so a run interrupted between them can repeat its last saved row.

## Output

Each dataset row represents one alert. The example uses illustrative product details.

```json
{
  "id": "https://data.food.gov.uk/food-alerts/id/FSA-AA-99-2026",
  "notation": "FSA-AA-99-2026",
  "type": "AA",
  "title": "Example Foods Ltd recalls chocolate biscuits because of undeclared milk",
  "created": "2026-10-20",
  "modified": "2026-10-21T14:00:00Z",
  "status": "Published",
  "problem": ["The affected product contains milk that is undeclared on the label."],
  "allergens": ["Milk"],
  "products": [{
    "name": "Chocolate biscuits",
    "packSize": "150 g",
    "batches": [{
      "batchCode": "B1234",
      "lotNumber": null,
      "bestBeforeDate": "2027-02-01",
      "bestBeforeDescription": null,
      "useByDate": null,
      "useByDescription": null
    }]
  }],
  "businesses": ["Example Foods Ltd"],
  "country": ["England", "Wales"],
  "alertUrl": "https://alerts.food.gov.uk/news-alerts/alert/fsa-aa-99-2026",
  "source": {
    "publisher": "Food Standards Agency",
    "url": "https://data.food.gov.uk/food-alerts/id.json",
    "license": "OGL v3.0",
    "licenseUrl": "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    "attribution": "Contains public sector information from the Food Standards Agency licensed under the Open Government Licence v3.0."
  }
}
```

Dates and lot codes stay attached to the batch they describe. A `null` value for `country` means the API supplied no country information. The alert may apply anywhere in the UK. The Actor preserves the published title, business names, and risk statements, replacing embedded email addresses and phone numbers with `[redacted]`. `businesses` is `null` when the API supplies no business names. `alertUrl` links to the FSA's published notice when a valid notice URL is supplied. The Actor also writes counts and the charge-limit flag to `RUN_SUMMARY` in the default key-value store.

## Data source and licence

Contains public sector information from the Food Standards Agency licensed under the Open Government Licence v3.0. This Actor normalizes selected fields from the FSA Food Alerts API. It is independently maintained and has no affiliation with the Food Standards Agency. [FSA Food Alerts API documentation](https://data.food.gov.uk/food-alerts/ui/reference) · [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)

Requests run sequentially at least 2.35 seconds apart. Network failures and HTTP 429 or 5xx responses are retried up to three times with backoff and `Retry-After` support. A response with an unrecognized structure fails the run. The API supplies the current version of each notice from January 2018 onward. Use the FSA notice as the source of record for any recall action.

## Local development

Run `npm ci`, `npm test`, and `apify run` from this directory with Node.js 22 and the Apify CLI. Offline tests use selected fields from real FSA responses, with sensitive or unnecessary text omitted. The fixture metadata records the request URLs. The examples cover all alert types, batch and lot details, a follow-up, and withdrawn notices.

## 日本語概要

英国食品基準庁の公式 API からアレルギー警報、製品回収、対応要請を取得します。アレルゲン・更新日・タイトルで絞り込み、監視モードでは新着、改訂、撤回を検出します。製品ごとに対象ロットと期限をまとめ、各行に原典 URL と OGL v3.0 の出典情報を付けます。
