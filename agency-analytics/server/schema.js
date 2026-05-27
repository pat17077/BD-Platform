// Single source of truth for the agency Sheets schema.
// db.js uses this to bootstrap missing tabs and validate headers.

const SCHEMA = {
  users: ['username', 'created_at', 'last_login_at', 'role'],

  issues: [
    // User-facing front-of-table columns
    'cusip', 'pricing_date', 'issuer', 'structure', 'size', 'coupon', 'fees',
    'spread', 'funding',
    'oas_par', 'oas_cost',
    's5s30s', 'yel',
    'settle_date', 'move',
    // Trailing detail / context columns
    'maturity_date', 'pricing_time_et',
    'model_funding_spread_bp', 'funding_spread_gap_bp', 'gap_signal',
    'funding_actual', 'funding_gap_bp',
    'model_pred', 'user_pred', 'user_confidence', 'pred_made_at',
    'yel_effective_date', 'dealers_count', 'pre_ioi', 'competing_prints',
    'ann_to_pricing_minutes', 'upsize_status', 'source_url', 'raw_source_json',
    'entered_by', 'market_sentiment', 'desk_notes', 'recent_5d_summary',
    'data_classification', 'ingested_at', 'version',
    'execution_speed', 'cover_bp', 'time_to_clear_mins',
    'bonds_left_street_mm', 'current_price', 'last_traded_price',
    'upsize_amount_mm', 'post_print_notes',
  ],

  call_schedules: ['cusip', 'call_date', 'call_price', 'is_european_approx'],

  curve_snapshots: ['snapshot_date', 'tenor', 'yield_pct'],

  move_snapshots: ['snapshot_date', 'move_close'],

  sofr_snapshots: ['snapshot_date', 'sofr_overnight', 'sofr_30d_avg', 'sofr_90d_avg'],

  predictions: [
    'prediction_id', 'username', 'predicted_at', 'model_version', 'input_json',
    'predicted_coupon_low', 'predicted_coupon_mid', 'predicted_coupon_high',
    'predicted_funding_spread_bp', 'confidence_interval_json', 'rationale_json',
    'actual_cusip', 'actual_coupon', 'actual_funding_spread_bp',
  ],

  model_versions: ['version', 'trained_at', 'training_set_size', 'metrics_json', 'artifact_path'],

  audit_log: ['id', 'timestamp', 'username', 'action', 'details_json'],

  predictions_draft: [
    'draft_id', 'created_at', 'created_by',
    'trade_date', 'issuer', 'structure', 'yel', 'yel_effective_date',
    'model_pred', 'user_pred', 'user_confidence', 'notes',
    'status', 'matched_cusip',
  ],

  pending_auctions: [
    'trade_date', 'bids_due_et', 'source', 'structure', 'settle_date',
    'maturity_date', 'first_call_date', 'next_pay_date', 'par_mm',
    'benchmark_desc', 'coupon', 'yel', 'ingested_at',
  ],

  indications: [
    'indication_id', 'created_at', 'created_by', 'trade_date', 'status',
    'issuer', 'structure', 'settle_date', 'maturity_date', 'first_call_date', 'yel',
    'size_mm',
    'predicted_coupon_low', 'predicted_coupon_mid', 'predicted_coupon_high',
    'predicted_spread', 'predicted_funding_spread',
    'aggressive_coupon', 'aggressive_funding',
    'cheap_coupon', 'cheap_funding',
    'speed_at_predicted', 'speed_score',
    'predicted_oas_par', 'predicted_oas_cost',
    'fees_used', 'sample_size', 'sigma_used', 'curve_date',
    'reasoning_json', 'market_color',
    'user_pred', 'user_confidence',
    'in_auction_at', 'refreshed_at',
    'actual_cusip', 'actual_coupon', 'actual_funding_spread', 'gap_bp',
    'updated_at',
  ],

  market_snapshots: [
    'snapshot_date',
    'ust_2y', 'ust_3y', 'ust_5y', 'ust_7y', 'ust_10y', 'ust_20y', 'ust_30y',
    'sofr_overnight', 's5s30s', 'move',
    'notes', 'updated_at', 'updated_by',
  ],

  // Tidal Finance landing-page email capture
  subscribers: [
    'email', 'audience', 'country', 'created_at', 'source', 'note',
  ],
};

const PRIMARY_KEYS = {
  users: ['username'],
  issues: ['cusip'],
  call_schedules: ['cusip', 'call_date'],
  curve_snapshots: ['snapshot_date', 'tenor'],
  move_snapshots: ['snapshot_date'],
  sofr_snapshots: ['snapshot_date'],
  predictions: ['prediction_id'],
  model_versions: ['version'],
  audit_log: ['id'],
  predictions_draft: ['draft_id'],
  pending_auctions: ['trade_date', 'structure', 'settle_date'],
  indications: ['indication_id'],
  market_snapshots: ['snapshot_date'],
  subscribers: ['email'],
};

module.exports = { SCHEMA, PRIMARY_KEYS };
