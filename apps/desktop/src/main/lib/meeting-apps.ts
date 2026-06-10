// Why: the system-audio tap should prefer the meeting app the speaker is on over the
// whole-system mixdown, so notification chimes / background music don't pollute
// the audio we classify and match. We pass this whitelist to the Swift helper,
// which taps the FIRST one currently running (NSWorkspace resolves a running
// app's bundleId) and otherwise falls back to the whole-system output — so
// behaviour is unchanged when the meeting isn't in a recognized app.
//
// Skewed toward apps common for CN knowledge workers (the product's
// users) plus the major international ones. Browsers are intentionally excluded:
// tapping a whole browser would re-introduce the music/notification noise we are
// trying to avoid (Google Meet etc. run in-tab with no dedicated process).
export const MEETING_APP_BUNDLE_IDS: readonly string[] = [
  'us.zoom.xos', // Zoom
  'com.tencent.meeting', // 腾讯会议 / VooV Meeting
  'com.alibaba.DingTalkMac', // 钉钉 DingTalk
  'com.bytedance.lark', // 飞书 / Lark (international)
  'com.bytedance.feishu', // 飞书 (mainland build)
  'com.microsoft.teams', // Microsoft Teams (classic)
  'com.microsoft.teams2', // Microsoft Teams (new)
  'Cisco-Systems.Spark', // Webex (Cisco)
];

// Why: only the speaker (system tap) channel should target a meeting app; your
// own mic must keep capturing you. Pure so it is unit-tested
// without spawning the Swift helper. Returns a fresh array so callers can mutate
// it (e.g. JSON payload assembly) without corrupting the shared whitelist.
export function meetingBundleIdsForSource(source: 'mic' | 'system'): string[] {
  return source === 'system' ? [...MEETING_APP_BUNDLE_IDS] : [];
}
