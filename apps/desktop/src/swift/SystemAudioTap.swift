// System-audio capture via a Core Audio process-tap (macOS 14.4+). Delivers the
// captured output as mono Float32 PCM to the recognizer. Default: whole-system
// output mixdown; pass a bundleId to tap only that running app's process.
//
// Validated end-to-end (insidegui/AudioCap pattern): global tap → private
// aggregate device → IO proc. Requires NSAudioCaptureUsageDescription; no
// "screen recording" permission. Conforms to AudioSource (see SpeechHelper.swift).
import Foundation
import CoreAudio
import AVFoundation
import AppKit

final class SystemTapSource: AudioSource {
    private let bundleIds: [String]
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var onBuffer: ((AVAudioPCMBuffer) -> Void)?
    private var monoFormat: AVAudioFormat?

    // Default-output-device change listener (headphones in/out, switching to an
    // external device) → rebuild the tap so capture follows the new device.
    private let listenerQueue = DispatchQueue(label: "qa.system-tap.listener")
    private var deviceListener: AudioObjectPropertyListenerBlock?
    private var defaultOutputAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    init(bundleIds: [String]) { self.bundleIds = bundleIds }

    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        self.onBuffer = onBuffer

        // Directed tap on the FIRST running meeting app whose bundleId resolves
        // (NSWorkspace is authoritative for a running app's bundleId); else the
        // whole-system output mixdown (exclude no processes).
        let desc: CATapDescription
        if let objID = bundleIds.lazy.compactMap({ Self.audioProcessObjectID(forBundleId: $0) }).first {
            desc = CATapDescription(stereoMixdownOfProcesses: [objID])
        } else {
            desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        }
        desc.isPrivate = true
        desc.muteBehavior = .unmuted

        var st = AudioHardwareCreateProcessTap(desc, &tapID)
        guard st == noErr, tapID != kAudioObjectUnknown else {
            throw AudioSourceError.unavailable("system_tap_create_failed_\(st)")
        }

        // Tap UID (to reference it from the aggregate) and stream format.
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var tapUID = "" as CFString
        var uidSz = UInt32(MemoryLayout<CFString>.size)
        st = withUnsafeMutablePointer(to: &tapUID) { AudioObjectGetPropertyData(tapID, &uidAddr, 0, nil, &uidSz, $0) }
        guard st == noErr else { stop(); throw AudioSourceError.unavailable("system_tap_uid_failed_\(st)") }

        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var asbdSz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        st = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &asbdSz, &asbd)
        guard st == noErr, asbd.mSampleRate > 0 else { stop(); throw AudioSourceError.unavailable("system_tap_format_failed_\(st)") }
        monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: asbd.mSampleRate, channels: 1, interleaved: false)

        // Private aggregate device wrapping the tap.
        let aggUID = "qa-matching-tap-\(UUID().uuidString)"
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceUIDKey as String: aggUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [
                [kAudioSubTapUIDKey as String: tapUID, kAudioSubTapDriftCompensationKey as String: true],
            ],
        ]
        st = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &aggID)
        guard st == noErr, aggID != kAudioObjectUnknown else { stop(); throw AudioSourceError.unavailable("system_aggregate_failed_\(st)") }

        let q = DispatchQueue(label: "qa.system-tap.io")
        st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, q) { [weak self] _, inInputData, _, _, _ in
            self?.handle(inInputData)
        }
        guard st == noErr, procID != nil else { stop(); throw AudioSourceError.unavailable("system_ioproc_failed_\(st)") }

        st = AudioDeviceStart(aggID, procID)
        guard st == noErr else { stop(); throw AudioSourceError.unavailable("system_device_start_failed_\(st)") }

        // Rebuild the tap when the default output device changes (e.g. headphones
        // plugged/unplugged), so system-audio capture follows the new device.
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.restart() }
        deviceListener = listener
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultOutputAddr, listenerQueue, listener)
    }

    // Tear down and re-establish the tap on the (new) default output device,
    // preserving the same buffer callback. Best-effort: if the device is briefly
    // unavailable mid-switch we stay stopped rather than crash.
    private func restart() {
        guard let cb = onBuffer else { return }
        stop()
        try? start(onBuffer: cb)
    }

    func stop() {
        if let l = deviceListener {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultOutputAddr, listenerQueue, l)
            deviceListener = nil
        }
        if let p = procID { AudioDeviceStop(aggID, p); AudioDeviceDestroyIOProcID(aggID, p); procID = nil }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID); aggID = kAudioObjectUnknown }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID); tapID = kAudioObjectUnknown }
        onBuffer = nil
    }

    // Downmix the tap's interleaved Float32 frames to mono and forward.
    private func handle(_ inInputData: UnsafePointer<AudioBufferList>) {
        guard let monoFormat, let cb = onBuffer else { return }
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        guard let first = abl.first, let mData = first.mData else { return }
        let ch = Int(first.mNumberChannels)
        let total = Int(first.mDataByteSize) / MemoryLayout<Float>.size
        let frames = ch > 0 ? total / ch : total
        guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(frames)),
              let dst = out.floatChannelData?[0] else { return }
        out.frameLength = AVAudioFrameCount(frames)
        let src = mData.assumingMemoryBound(to: Float.self)
        if ch <= 1 {
            for f in 0..<frames { dst[f] = src[f] }
        } else {
            for f in 0..<frames {
                var sum: Float = 0
                for c in 0..<ch { sum += src[f * ch + c] }
                dst[f] = sum / Float(ch)
            }
        }
        cb(out)
    }

    // Translate a running app's bundleId → PID → Core Audio process object ID.
    private static func audioProcessObjectID(forBundleId bundleId: String) -> AudioObjectID? {
        guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else { return nil }
        var pid = app.processIdentifier
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var objID = AudioObjectID(kAudioObjectUnknown)
        var sz = UInt32(MemoryLayout<AudioObjectID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &pid, &sz, &objID)
        return (st == noErr && objID != kAudioObjectUnknown) ? objID : nil
    }
}
