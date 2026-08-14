/**
 * Profile bootstrap constants used by the per-kind registrations:
 * `profile_snapshot` sizes itself against a profile-INDEPENDENT bootstrap
 * maximum (spec §7.1/§4.3), never against a profile-owned limit.
 */
export const AUTHORITATIVE_REVIEW_PROFILE_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;