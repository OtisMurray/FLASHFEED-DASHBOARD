// Describes the prediction model a refresh cycle actually loaded.
//
// loadLatestPredictionModel() findOne()s by PREDICTION_MODEL_ID and returns null
// when no such document exists. 2fac48a repointed that constant from the literal
// "trade_watch_linear_v1" to INTRADAY_MODEL_ID ('trade_watch_direction_v2') on
// 2026-07-29, and no v2 document has ever been written, so it has been null on
// every cycle since. runDataRefreshCycle read .status straight off it, which
// threw — at the tail of the cycle, inside the returned object, after every
// ingest step had already completed. The three callers differed only in how
// loudly they lost the result: /api/fetch answered 500, the SSE and on-site
// tickers logged and skipped their disk persist, and autoGrabTick's
// `catch (_) {}` swallowed it in silence for a week while ingestion kept working.
//
// The missing document is named rather than reported as empty. A guard that
// returned undefined would trade a crash for silence, and "no model document
// exists" is the actual state of production — worth being able to see in the
// response rather than having to infer from a blank field.
export const PREDICTION_MODEL_ABSENT = 'absent_no_model_document'
export const PREDICTION_MODEL_NO_STATUS = 'loaded_without_status'

export function predictionModelStatus(model) {
  if (!model) return PREDICTION_MODEL_ABSENT
  // A stored document carries no `status` of its own — only the object
  // trainPredictionModel() synthesises does. Distinguish "we loaded something
  // that does not describe itself" from "there was nothing to load".
  return model.status ?? PREDICTION_MODEL_NO_STATUS
}
