import { describe, it, expect } from 'vitest';
import { MEETING_APP_BUNDLE_IDS, meetingBundleIdsForSource } from './meeting-apps.js';

describe('meetingBundleIdsForSource', () => {
  it('targets the meeting-app whitelist for the system (speaker) channel', () => {
    const ids = meetingBundleIdsForSource('system');
    expect(ids).toEqual([...MEETING_APP_BUNDLE_IDS]);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('returns no bundle ids for the mic (self) channel', () => {
    // Your own mic must never be redirected to a meeting app's audio.
    expect(meetingBundleIdsForSource('mic')).toEqual([]);
  });

  it('returns a fresh array so callers can mutate without corrupting the whitelist', () => {
    const a = meetingBundleIdsForSource('system');
    a.push('com.evil.app');
    expect(meetingBundleIdsForSource('system')).not.toContain('com.evil.app');
  });

  it('excludes browsers (tapping a whole browser re-introduces music/notification noise)', () => {
    const browsers = ['com.google.Chrome', 'com.apple.Safari', 'org.mozilla.firefox', 'com.microsoft.edgemac'];
    for (const b of browsers) expect(MEETING_APP_BUNDLE_IDS).not.toContain(b);
  });
});
