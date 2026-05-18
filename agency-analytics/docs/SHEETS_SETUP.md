# Google Sheets Setup — Agency New Issue Analytics

This module uses a Google Sheets workbook as its persistence layer. One-time setup below — do this once and the server will read/write transparently.

## 1. Create the spreadsheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new blank spreadsheet.
2. Name it `Agency New Issue Analytics`.
3. Create the following tabs (rename `Sheet1` and add new tabs via the `+` button). Tab names are case-sensitive — match exactly:
   - `users`
   - `issues`
   - `call_schedules`
   - `curve_snapshots`
   - `move_snapshots`
   - `sofr_snapshots`
   - `predictions`
   - `model_versions`
   - `audit_log`

4. Add the header rows to each tab. Row 1 of each tab must contain the column names exactly as listed below (the server reads by column name, so spelling matters).

### `users`
```
username | created_at | last_login_at | role
```

### `issues`
```
cusip | issuer | pricing_date | pricing_time_et | settle_date | maturity_date | structure | coupon | size_dollars | fees_dollars | actual_funding_spread_bp | model_funding_spread_bp | funding_spread_gap_bp | gap_signal | spread_to_ct_treasury_bp | oas_at_par_bp | oas_at_cost_bp | s2s30s_at_auction_bp | move_prior_close | yel_designation | ann_to_pricing_minutes | upsize_status | source_url | raw_source_json | data_classification | ingested_at | version
```

### `call_schedules`
```
cusip | call_date | call_price | is_european_approx
```

### `curve_snapshots`
```
snapshot_date | tenor | yield_pct
```

### `move_snapshots`
```
snapshot_date | move_close
```

### `sofr_snapshots`
```
snapshot_date | sofr_overnight | sofr_30d_avg | sofr_90d_avg
```

### `predictions`
```
prediction_id | username | predicted_at | model_version | input_json | predicted_coupon_low | predicted_coupon_mid | predicted_coupon_high | predicted_funding_spread_bp | confidence_interval_json | rationale_json | actual_cusip | actual_coupon | actual_funding_spread_bp
```

### `model_versions`
```
version | trained_at | training_set_size | metrics_json | artifact_path
```

### `audit_log`
```
id | timestamp | username | action | details_json
```

## 2. Create a Google Cloud project + service account

1. Go to [Google Cloud Console](ll).
2. Top bar → project dropdown → **New Project**. Name it `agency-analytics` (or anything). Click **Create**.
3. With the new project selected, open the navigation menu → **APIs & Services** → **Library**.
4. Search for **Google Sheets API** → click → **Enable**.
5. Navigation menu → **APIs & Services** → **Credentials** → **+ Create Credentials** → **Service account**.
6. Service account name: `agency-analytics-server`. Click **Create and Continue**. Skip role assignment. Click **Done**.
7. In the credentials list, click the new service account email → **Keys** tab → **Add Key** → **Create new key** → **JSON** → **Create**. A JSON file downloads.
8. Move the downloaded JSON file to:
   ```
   /Users/ragnaag/Desktop/bd/main/agency-analytics/data/service-account.json
   ```
   (this directory is gitignored — never commit this file)

## 3. Share the spreadsheet with the service account

1. Open `service-account.json` in a text editor and copy the value of the `"client_email"` field. It looks like:
   ```
   agency-analytics-server@agency-analytics-12345.iam.gserviceaccount.com
   ```
2. Back in the Google Sheet, click **Share** (top right).
3. Paste the service account email. Permission: **Editor**. Uncheck "Notify people". Click **Share**.

## 4. Grab the spreadsheet ID

The URL of your spreadsheet looks like:
```
https://docs.google.com/spreadsheets/d/1AbC...xyz/edit
```
Copy the `1AbC...xyz` part — that's the spreadsheet ID.

## 5. Add environment variables

Append to `/Users/ragnaag/Desktop/bd/main/.env`:

```
AGENCY_SHEET_ID=<paste spreadsheet ID here>
AGENCY_SERVICE_ACCOUNT_PATH=./agency-analytics/data/service-account.json
AGENCY_SESSION_SECRET=<run: openssl rand -hex 32>
AGENCY_USER1_HASH=<bcrypt hash for you — server will print this>
AGENCY_USER2_HASH=<bcrypt hash for your father — server will print this>
AGENCY_USER1_NAME=<your username>
AGENCY_USER2_NAME=<father's username>
```

## 6. Generate password hashes

After installing dependencies (`npm install` in `main/`), run:

```bash
node agency-analytics/server/hash-password.js <your-chosen-password>
```

It prints a bcrypt hash to paste into `.env`. Run it twice — once for your password, once for your father's password.

## 7. Verify

Start the server (`./start.sh`). On boot you should see:
```
[agency] connected to sheet: Agency New Issue Analytics (1AbC...xyz)
[agency] users sheet: 2 rows
[agency] issues sheet: 0 rows
[agency] ready
```

If you see auth or sheet-not-found errors, the most common causes are:
- Service account JSON not at the path in `.env`
- Sheet ID in `.env` doesn't match URL
- Sheet not shared with the service account email
- Tab names mistyped (must match section 1 exactly)
