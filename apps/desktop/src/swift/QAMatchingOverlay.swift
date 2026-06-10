//
//  QAMatchingOverlay.swift
//  QA Matching — native NSPanel overlay helper.
//
//  Spawned as a child process by the Electron main process.
//  Protocol: newline-delimited JSON on stdin/stdout.
//
//  stdin  commands:
//    {"action":"show","cards":[...]}   — show panel (cards may be empty)
//    {"action":"update","cards":[...]} — replace card list while panel is visible
//    {"action":"hide"}                 — dismiss panel with animation
//    {"action":"quit"}                 — terminate process
//
//  stdout events:
//    {"type":"ready"}                          — emitted once on startup
//    {"type":"dismissed"}                      — emitted when the panel fully disappears
//    {"type":"resized","width":W,"height":H}   — emitted when user drags the resize handle
//
//  NSPanel configuration mirrors Textream NotchOverlayController.showPinned()
//  (github.com/f/textream, MIT License).
//

import AppKit
import SwiftUI
import Foundation

// MARK: - Data

struct QACard: Identifiable, Equatable {
    var id: String
    var type: String
    var title: String
    var summary: String
    var details: String
    var tags: [String]
    var isImportant: Bool
}

// MARK: - State

class OverlayState: ObservableObject {
    @Published var cards: [QACard] = []
    @Published var currentIndex: Int = 0
    @Published var shouldDismiss: Bool = false
    // Mutable so resizePanel() can animate them without recreating the view.
    @Published var panelW: CGFloat = 600
    @Published var contentH: CGFloat = 200

    var currentCard: QACard? {
        guard !cards.isEmpty, currentIndex < cards.count else { return nil }
        return cards[currentIndex]
    }

    // Measured height of cardContent; updated by onPreferenceChange so panel drag minimum is accurate.
    var measuredCardH: CGFloat = 0
    // Why: set true during the resize-handle drag so onPreferenceChange auto-expand cannot
    // fight against the drag gesture and cause oscillation/jitter.
    var isDragging: Bool = false
    // Called directly during user drag to resize NSPanel frame in real time (no animation).
    var resizeCallback: ((CGFloat, CGFloat) -> Void)?
    // Called once when the drag gesture ends; the panel uses it to persist the new size.
    var resizeDoneCallback: ((CGFloat, CGFloat) -> Void)?
}

// MARK: - Dynamic Island Shape
// Source: Textream/NotchOverlayController.swift (MIT, github.com/f/textream)
// Concave top corners match the hardware notch edge; convex bottom corners.

struct DynamicIslandShape: Shape {
    var topInset: CGFloat = 16
    var bottomRadius: CGFloat = 18

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(topInset, bottomRadius) }
        set { topInset = newValue.first; bottomRadius = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        let t = topInset, br = bottomRadius
        var p = Path()
        // Top-left: concave — bows inward to match the notch edge
        p.move(to: CGPoint(x: 0, y: 0))
        p.addQuadCurve(to: CGPoint(x: t, y: t), control: CGPoint(x: t, y: 0))
        // Left edge down to bottom-left convex corner
        p.addLine(to: CGPoint(x: t, y: h - br))
        p.addQuadCurve(to: CGPoint(x: t + br, y: h), control: CGPoint(x: t, y: h))
        // Bottom edge to bottom-right convex corner
        p.addLine(to: CGPoint(x: w - t - br, y: h))
        p.addQuadCurve(to: CGPoint(x: w - t, y: h - br), control: CGPoint(x: w - t, y: h))
        // Right edge up to top-right concave
        p.addLine(to: CGPoint(x: w - t, y: t))
        p.addQuadCurve(to: CGPoint(x: w, y: 0), control: CGPoint(x: w - t, y: 0))
        p.closeSubpath()
        return p
    }
}

// MARK: - Content Height Measurement
// Why: PreferenceKey bubbles the rendered cardContent height up to the parent view so
// the overlay can auto-expand the NSPanel to always fit the text without clipping.

private struct ContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Type Label / Color Maps

private let typeLabel: [String: String] = [
    "result_impact": "结果影响", "data_metric": "数据指标",
    "difficulty_solution": "难点解法", "decision_tradeoff": "决策权衡",
    "tech_principle": "技术原理", "process_method": "流程方法",
    "domain_fact": "领域知识",
]

private let typeColor: [String: Color] = [
    "result_impact": .green, "data_metric": .blue, "difficulty_solution": .red,
    "decision_tradeoff": .yellow, "tech_principle": .purple,
    "process_method": .cyan, "domain_fact": .gray,
]

private func keySentences(_ text: String, max: Int = 2) -> String {
    let parts = text
        .components(separatedBy: CharacterSet(charactersIn: "。！？.!?"))
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { $0.count >= 15 }
    guard !parts.isEmpty else { return String(text.prefix(80)) + "…" }
    return parts.prefix(max).joined(separator: "。")
}

// MARK: - Overlay SwiftUI View
// Expand/collapse animation mirrors Textream NotchOverlayView.onAppear / shouldDismiss.

struct QAMatchingOverlayView: View {
    @ObservedObject var state: OverlayState
    let menuBarH: CGFloat   // notch+menu-bar height: 37pt on MBP 14/16", 24pt on older Macs
    var onDismiss: () -> Void

    // 0 = collapsed to notch width/height; 1 = fully expanded
    @State private var expansion: CGFloat = 0
    @State private var contentVisible = false

    private let notchW: CGFloat = 200
    private let topInset: CGFloat = 16
    private let bottomRadius: CGFloat = 18

    // Read from state so resizePanel() can animate these without recreating the view.
    private var expandedH: CGFloat { menuBarH + state.contentH }
    private var currentH: CGFloat  { menuBarH + state.contentH * expansion }
    private var currentW: CGFloat  { notchW + (state.panelW - notchW) * expansion }
    private var cTopInset: CGFloat { 8 + (topInset - 8) * expansion }
    private var cBottomR:  CGFloat { 8 + (bottomRadius - 8) * expansion }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                // Pure black background, no border
                DynamicIslandShape(topInset: cTopInset, bottomRadius: cBottomR)
                    .fill(Color.black)
                    .frame(width: currentW, height: currentH)

                // Content + drag handle — fades in after container expands
                if contentVisible {
                    VStack(spacing: 0) {
                        // Spacer = menu-bar / hardware-notch gap.
                        Color.clear.frame(height: menuBarH)

                        // Card area: content on top, drag handle pinned to bottom.
                        VStack(spacing: 0) {
                            cardContent
                                // Why: GeometryReader measures the actual rendered height so
                                // onPreferenceChange can auto-expand the panel to fit content.
                                .background(
                                    GeometryReader { g in
                                        Color.clear.preference(
                                            key: ContentHeightKey.self,
                                            value: g.size.height
                                        )
                                    }
                                )
                            Spacer(minLength: 8)
                            // Drag handle — pull down to grow, pull up to shrink
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.white.opacity(0.22))
                                .frame(width: 32, height: 4)
                                .padding(.bottom, 8)
                        }
                        .frame(height: state.contentH)
                    }
                    .frame(width: currentW, height: expandedH)
                    // Why: clipShape (not plain .clipped) so rounded bottom corners
                    // of the shape mask content — otherwise text renders on the
                    // transparent corner triangles outside the black background.
                    .clipShape(DynamicIslandShape(topInset: cTopInset, bottomRadius: cBottomR))
                    .transition(.opacity)
                }
            }
            .frame(width: currentW, height: currentH, alignment: .top)
            .clipped()  // prevent overflow beyond animated height during expand/collapse
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
        }
        // Auto-expand the panel when content is taller than the current contentH.
        // Why: suppressed during active drag — the drag gesture sets contentH directly,
        // and auto-expand fighting it causes the height to oscillate (jitter).
        .onPreferenceChange(ContentHeightKey.self) { h in
            guard h > 4, !state.isDragging else { return }
            state.measuredCardH = h
            // contentH must fit: content + Spacer(min 8) + drag handle (4 + 8 = 12)
            let needed = h + 20
            guard needed > state.contentH else { return }
            DispatchQueue.main.async {
                guard !state.isDragging else { return }
                state.contentH = needed
                state.resizeCallback?(state.panelW, needed)
            }
        }
        .onAppear {
            // Phase 1: expand container (matches Textream 0.4s easeOut)
            withAnimation(.easeOut(duration: 0.4)) { expansion = 1 }
            // Phase 2: reveal content after container is mostly open
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                withAnimation(.easeOut(duration: 0.25)) { contentVisible = true }
            }
        }
        .onChange(of: state.shouldDismiss) { _, should in
            guard should else { return }
            // Reverse: content fades first, then container collapses
            withAnimation(.easeIn(duration: 0.15)) { contentVisible = false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                withAnimation(.easeIn(duration: 0.30)) { expansion = 0 }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { onDismiss() }
        }
    }

    @ViewBuilder
    private var cardContent: some View {
        if let card = state.currentCard {
            VStack(alignment: .leading, spacing: 0) {
                // ── Header row ────────────────────────────────────────────────
                HStack(spacing: 4) {
                    Circle()
                        .fill(typeColor[card.type] ?? .gray)
                        .frame(width: 7, height: 7)
                    Text(typeLabel[card.type] ?? card.type)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.62))
                        .textCase(.uppercase)
                        .lineLimit(1)
                    if card.isImportant {
                        Text("★").font(.system(size: 10)).foregroundStyle(.yellow)
                    }
                    Spacer()
                    // Navigation (only when multiple cards)
                    if state.cards.count > 1 {
                        navBtn("‹", enabled: state.currentIndex > 0) {
                            state.currentIndex = max(0, state.currentIndex - 1)
                        }
                        Text("\(state.currentIndex + 1)/\(state.cards.count)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.35))
                        navBtn("›", enabled: state.currentIndex < state.cards.count - 1) {
                            state.currentIndex = min(state.cards.count - 1, state.currentIndex + 1)
                        }
                    }
                    // Close button
                    Button { state.shouldDismiss = true } label: {
                        Text("×")
                            .font(.system(size: 14, weight: .light))
                            .frame(width: 18, height: 18)
                            .foregroundStyle(.white.opacity(0.45))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 28)
                .padding(.top, 8)

                // ── Title ─────────────────────────────────────────────────────
                Text(card.title)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white.opacity(0.95))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 28)
                    .padding(.top, 3)

                // ── Details preview ───────────────────────────────────────────
                Text(keySentences(card.details))
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 28)
                    .padding(.top, 3)
                    .padding(.bottom, 8)
            }
        } else {
            HStack {
                Text("等待匹配…")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.2))
                Spacer()
                Button { state.shouldDismiss = true } label: {
                    Text("×").font(.system(size: 14)).foregroundStyle(.white.opacity(0.35))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 12)
        }
    }

    private func navBtn(_ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 14))
                .frame(width: 18, height: 18)
                .foregroundStyle(.white.opacity(enabled ? 0.40 : 0.15))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

// MARK: - Scroll-Intercepting Hosting View
// Why: NSHostingView doesn't expose scrollWheel by default. Subclassing lets us
// capture two-finger swipe gestures for card/question navigation without blocking
// the hosting view's normal mouse/click handling.

private class ScrollHostingView<R: View>: NSHostingView<R> {
    var onScroll:      ((CGFloat, CGFloat) -> Void)?   // (dx, dy) — active finger movement
    var onScrollBegan: (() -> Void)?                    // gesture started
    var onScrollEnded: (() -> Void)?                    // fingers lifted / momentum started / cancelled
    var onDragChanged: ((CGFloat, CGFloat) -> Void)?   // (newW, newH) — live drag
    var onDragEnded:   ((CGFloat, CGFloat) -> Void)?   // (finalW, finalH) — drag released
    var getBaseSize:   (() -> (CGFloat, CGFloat))?     // returns (panelW, contentH) at drag start

    private var qaTrackingArea: NSTrackingArea?
    private var dragFrom:  NSPoint?   // window coords captured at mouseDown
    private var dragBaseW: CGFloat = 0
    private var dragBaseH: CGFloat = 0
    private var dragLastW: CGFloat = 0
    private var dragLastH: CGFloat = 0

    override func scrollWheel(with event: NSEvent) {
        // Why: momentumPhase.began fires the moment fingers leave the trackpad and
        // deceleration starts. Treating it as "ended" resets state before momentum
        // deltas can accumulate and re-trigger navigation in the same gesture.
        if event.momentumPhase.contains(.began) {
            onScrollEnded?()
            return
        }
        // Ignore ongoing momentum — only intentional finger movement should navigate.
        guard event.momentumPhase.isEmpty else { return }

        if event.phase.contains(.began) { onScrollBegan?() }
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            onScrollEnded?()
            return  // don't accumulate delta on the final (usually near-zero) ended event
        }
        let dx = event.scrollingDeltaX
        let dy = event.scrollingDeltaY
        if abs(dx) > 0 || abs(dy) > 0 { onScroll?(dx, dy) }
    }

    // Why: SwiftUI's internal NSViews inside NSHostingView normally win the hit test
    // across the entire bounds, intercepting cursorUpdate and mouse events before this
    // view ever sees them. Returning self for the bottom 20pt (drag handle zone) forces
    // AppKit to route cursorUpdate and mouseDown/mouseDragged/mouseUp here for that region.
    // NSHostingView.isFlipped == true (SwiftUI coordinate system) → y=0 at top, y increases
    // downward; visual bottom = y near bounds.height, so drag zone = y >= bounds.height - 20.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        let dragH: CGFloat = 20
        if local.y >= bounds.height - dragH && local.x >= 0 && local.x < bounds.width {
            return self
        }
        return super.hitTest(point)
    }

    // Why: NSTrackingArea with .activeAlways delivers cursorUpdate even when the panel
    // is not key. SwiftUI's .onHover and .activeInKeyWindow areas never fire for a
    // nonactivatingPanel. .inVisibleRect auto-covers the current bounds on resize,
    // making rect:.zero the correct idiom (AppKit ignores rect when .inVisibleRect is set).
    // Storing the area reference avoids removing unrelated tracking areas on every resize.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let old = qaTrackingArea { removeTrackingArea(old) }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.activeAlways, .mouseMoved, .cursorUpdate, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        qaTrackingArea = area
    }

    // Why: hitTest already restricts this call to the drag zone, so no coordinate check
    // is needed — just set the resize cursor unconditionally.
    // The NSLog probe verifies that AppKit routes the event here at all; wrap in #if DEBUG
    // so the log is stripped from release builds without a separate removal step.
    override func cursorUpdate(with event: NSEvent) {
        NSLog("[QAOverlay] cursorUpdate called at \(event.locationInWindow)")
        NSCursor.resizeUpDown.set()
    }

    // Drag gesture is handled at NSResponder level so hitTest (above) has exclusive
    // ownership of the drag zone — no SwiftUI DragGesture competes for the same region.

    override func mouseDown(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        let dragH: CGFloat = 20
        // isFlipped == true → y=0 at top, y increases down; drag handle at visual bottom = high y.
        guard local.y >= bounds.height - dragH else {
            super.mouseDown(with: event)
            return
        }
        dragFrom = event.locationInWindow
        let (bW, bH) = getBaseSize?() ?? (600, 200)
        dragBaseW = bW; dragBaseH = bH
        dragLastW = bW; dragLastH = bH
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragFrom else {
            super.mouseDragged(with: event)
            return
        }
        let cur = event.locationInWindow
        let dW  = cur.x - start.x
        // y=0 at bottom in window coords: dragging handle down → cur.y < start.y → height grows.
        let dH  = start.y - cur.y
        let newW = max(50, dragBaseW + dW)
        let newH = max(60, dragBaseH + dH)
        dragLastW = newW; dragLastH = newH
        onDragChanged?(newW, newH)
    }

    override func mouseUp(with event: NSEvent) {
        guard dragFrom != nil else {
            super.mouseUp(with: event)
            return
        }
        dragFrom = nil
        onDragEnded?(dragLastW, dragLastH)
    }
}

// MARK: - Panel Manager
// All NSPanel configuration values taken verbatim from Textream showPinned() (MIT).

class QAMatchingPanel: NSObject {
    private var panel: NSPanel?
    let state = OverlayState()
    private var onDismissed: (() -> Void)?
    // Config applied on next show (size) or live (screenshot protection)
    private var cfgWidth: CGFloat = 600
    private var cfgHeight: CGFloat = 200
    private var cfgScreenshotProtected: Bool = true
    // ── Scroll-gesture state ──────────────────────────────────────────────────
    private enum ScrollAxis { case none, horizontal, vertical }
    private var scrollAccumX:    CGFloat    = 0
    private var scrollAccumY:    CGFloat    = 0
    private var scrollAxis:      ScrollAxis = .none
    private var scrollTriggered: Bool       = false
    // Why: idle timer catches the case where fingers stop moving but never fire
    // .ended (seen on some trackpad configurations and under "Natural Scrolling").
    // After 120ms without delta events the gesture is treated as complete.
    private var scrollIdleTimer: DispatchWorkItem?

    // Why: named constants so sensitivity tuning is a one-line change here,
    // not a grep through the gesture logic below.
    private let kHScrollThreshold:   CGFloat = 100  // pt horizontal to flip one card
    private let kVScrollThreshold:   CGFloat = 120  // pt vertical to switch one question
    private let kAxisLockMinTotal:   CGFloat = 30   // min combined pt before axis decision
    private let kAxisDominanceRatio: CGFloat = 1.5  // dominant/secondary ≥ ratio to lock axis

    // Why: called on every gesture-boundary event (began, ended, cancelled,
    // momentum start, 120ms idle) so exactly one action fires per physical gesture.
    private func resetScrollState() {
        scrollIdleTimer?.cancel(); scrollIdleTimer = nil
        scrollAccumX = 0; scrollAccumY = 0
        scrollAxis = .none; scrollTriggered = false
    }

    // Set by AppDelegate to emit {"type":"resized",...} when the user finishes dragging.
    var onResizedByDrag: ((CGFloat, CGFloat) -> Void)?
    // Set by AppDelegate to emit {"type":"question-nav",...} on vertical swipe.
    var onQuestionNav: ((Int) -> Void)?

    func show(cards: [QACard], width: CGFloat, height: CGFloat,
              screenshotProtected: Bool, onDismissed: @escaping () -> Void) {
        self.onDismissed = onDismissed
        cfgWidth = width
        cfgHeight = height
        cfgScreenshotProtected = screenshotProtected
        state.shouldDismiss = false
        state.cards = cards
        if panel != nil {
            // Panel already visible: resize in-place, preserve card navigation position.
            resizePanel(toWidth: width, height: height)
        } else {
            state.currentIndex = 0
            openPanel()
        }
    }

    func update(cards: [QACard]) {
        state.cards = cards
        state.currentIndex = 0
        if panel == nil { openPanel() }
    }

    // Animate the NSPanel frame and SwiftUI layout simultaneously so the user
    // sees a smooth resize instead of a destroy-recreate flash.
    private func resizePanel(toWidth width: CGFloat, height: CGFloat) {
        guard let p = panel, let screen = NSScreen.main else { return }
        let sf = screen.frame
        let vf = screen.visibleFrame
        let menuBarH = sf.maxY - vf.maxY
        let panelH   = menuBarH + height
        let x        = sf.midX - width / 2
        let y        = sf.maxY - panelH
        withAnimation(.easeOut(duration: 0.18)) {
            state.panelW   = width
            state.contentH = height
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration        = 0.18
            ctx.timingFunction  = CAMediaTimingFunction(name: .easeOut)
            p.animator().setFrame(NSRect(x: x, y: y, width: width, height: panelH), display: true)
        }
    }

    // Direct (no animation) resize — used by the drag handle for real-time response.
    private func resizePanelFrame(toWidth width: CGFloat, height: CGFloat) {
        guard let p = panel, let screen = NSScreen.main else { return }
        let sf = screen.frame
        let vf = screen.visibleFrame
        let menuBarH = sf.maxY - vf.maxY
        let panelH   = menuBarH + height
        let x        = sf.midX - width / 2
        let y        = sf.maxY - panelH
        p.setFrame(NSRect(x: x, y: y, width: width, height: panelH), display: true)
    }

    func hide() {
        state.shouldDismiss = true
    }

    // Live-toggle screenshot visibility without restarting the panel
    func setScreenshotProtected(_ on: Bool) {
        cfgScreenshotProtected = on
        panel?.sharingType = on ? .none : .readOnly
    }

    private func openPanel() {
        guard let screen = NSScreen.main else { return }
        let sf = screen.frame          // full screen bounds (y-axis goes UP on macOS)
        let vf = screen.visibleFrame   // area below menu bar / above Dock

        let menuBarH = sf.maxY - vf.maxY
        let panelW   = cfgWidth
        let contentH = cfgHeight
        let panelH   = menuBarH + contentH

        let x = sf.midX - panelW / 2
        let y = sf.maxY - panelH

        // Sync state before view creation so the SwiftUI layout starts with the right values.
        state.panelW   = panelW
        state.contentH = contentH

        // Wire up resize callback so SwiftUI preference-change auto-expand can resize the panel.
        state.resizeCallback = { [weak self] w, h in
            self?.resizePanelFrame(toWidth: w, height: h)
        }

        let view = QAMatchingOverlayView(
            state: state,
            menuBarH: menuBarH,
            onDismiss: { [weak self] in
                DispatchQueue.main.async {
                    self?.panel?.orderOut(nil)
                    self?.panel = nil
                    self?.onDismissed?()
                }
            }
        )

        // ── NSPanel configuration (Textream showPinned, MIT) ─────────────────
        //
        //  [.borderless, .nonactivatingPanel]
        //    → no title bar / decorations; clicking panel never steals key focus
        //      from the user's active app (Zoom, VS Code, terminal, etc.)
        //
        //  level = .screenSaver (1000)
        //    → above menu bar (.statusBar = 25) and above all normal app windows
        //
        //  .canJoinAllSpaces   → visible on every virtual desktop / Space
        //  .fullScreenAuxiliary → persists over fullscreen apps (Safari, Zoom, etc.)
        //  .stationary         → no slide animation when the user switches Spaces
        //  .ignoresCycle       → excluded from Cmd+` window cycling
        //
        //  sharingType = .none → hidden from screen recording and Zoom screen share
        let p = NSPanel(
            contentRect: NSRect(x: x, y: y, width: panelW, height: panelH),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = .screenSaver
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.ignoresMouseEvents = false
        p.sharingType = cfgScreenshotProtected ? .none : .readOnly
        // Why: disableCursorRects() stops the panel from resetting cursor state during
        // its own repaint cycle, so our tracking-area cursorUpdate has the final word.
        p.disableCursorRects()

        // wantsLayer=true ensures the CALayer exists before setting opacity properties.
        let hv = ScrollHostingView(rootView: view)
        hv.wantsLayer = true
        hv.layer?.isOpaque = false
        hv.layer?.backgroundColor = .clear

        // Two-finger swipe: left/right = flip card, up/down = switch question.
        hv.onScrollBegan = { [weak self] in self?.resetScrollState() }
        hv.onScrollEnded = { [weak self] in self?.resetScrollState() }

        hv.onScroll = { [weak self] dx, dy in
            guard let self, !self.scrollTriggered else { return }

            // Why: reschedule idle timer on every delta event.  If the user holds
            // two fingers still on the trackpad without lifting, no .ended fires;
            // after 120ms of silence we treat the gesture as done so the next
            // movement starts fresh instead of accumulating from where they paused.
            self.scrollIdleTimer?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.resetScrollState() }
            self.scrollIdleTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)

            self.scrollAccumX += dx
            self.scrollAccumY += dy

            // Axis lock: collect enough movement, then lock only when one direction
            // clearly dominates. A diagonal swipe (ratio ≈ 1:1) keeps accumulating
            // without locking, so it can never accidentally trigger either axis.
            if self.scrollAxis == .none {
                let ax = abs(self.scrollAccumX), ay = abs(self.scrollAccumY)
                guard ax + ay >= self.kAxisLockMinTotal else { return }
                guard ax >= ay * self.kAxisDominanceRatio
                   || ay >= ax * self.kAxisDominanceRatio else { return }
                self.scrollAxis = ax >= ay ? .horizontal : .vertical
            }

            switch self.scrollAxis {
            case .horizontal:
                // Negative accumX = fingers dragged left = advance to next card.
                if self.scrollAccumX < -self.kHScrollThreshold {
                    self.scrollTriggered = true
                    let next = self.state.currentIndex + 1
                    if next < self.state.cards.count { self.state.currentIndex = next }
                } else if self.scrollAccumX > self.kHScrollThreshold {
                    self.scrollTriggered = true
                    let prev = self.state.currentIndex - 1
                    if prev >= 0 { self.state.currentIndex = prev }
                }
            case .vertical:
                // Why: scrollingDeltaY sign with Natural Scrolling ON (macOS default):
                //   Positive deltaY = two fingers dragged UPWARD on trackpad.
                //   Negative deltaY = two fingers dragged DOWNWARD on trackpad.
                // Question list is newest-first (index 0 = top). Up-swipe scrolls
                // toward older questions (higher index); down-swipe toward newer (lower).
                if self.scrollAccumY > self.kVScrollThreshold {
                    self.scrollTriggered = true
                    self.onQuestionNav?(1)   // fingers up → older question (index + 1)
                } else if self.scrollAccumY < -self.kVScrollThreshold {
                    self.scrollTriggered = true
                    self.onQuestionNav?(-1)  // fingers down → newer question (index − 1)
                }
            case .none: break
            }
        }

        // Drag handle: NSResponder overrides in ScrollHostingView handle resize.
        hv.getBaseSize = { [weak self] in
            guard let self else { return (600, 200) }
            return (self.state.panelW, self.state.contentH)
        }
        hv.onDragChanged = { [weak self] newW, newH in
            guard let self else { return }
            self.state.isDragging = true
            self.state.panelW   = newW
            self.state.contentH = newH
            self.resizePanelFrame(toWidth: newW, height: newH)
        }
        hv.onDragEnded = { [weak self] finalW, finalH in
            guard let self else { return }
            self.state.isDragging = false
            self.cfgWidth  = finalW
            self.cfgHeight = finalH
            self.onResizedByDrag?(finalW, finalH)
        }

        p.contentView = hv

        p.orderFrontRegardless()

        self.panel = p
    }

    private func closePanel() {
        panel?.orderOut(nil)
        panel = nil
    }

    var isShowing: Bool { panel != nil }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    let qaPanel = QAMatchingPanel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Forward drag-resize events to Electron so the slider UI stays in sync.
        qaPanel.onResizedByDrag = { [weak self] w, h in
            self?.emitJSON(["type": "resized", "width": Double(w), "height": Double(h)])
        }
        // Forward vertical-swipe question navigation to Electron.
        qaPanel.onQuestionNav = { [weak self] delta in
            self?.emitJSON(["type": "question-nav", "delta": delta])
        }
        // Why: emit the binary's own modification date as "build" so Electron can
        // log and confirm it is running the freshly compiled binary, not a stale one.
        let build: String = {
            let path = CommandLine.arguments[0]
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let date  = attrs[.modificationDate] as? Date {
                return ISO8601DateFormatter().string(from: date)
            }
            return "unknown"
        }()
        emitJSON(["type": "ready", "build": build])
        startStdinReader()
    }

    // Keep the process alive between panel show/hide cycles
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    private func emitJSON(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let str = String(data: data, encoding: .utf8) else { return }
        print(str)
        fflush(stdout)
    }

    private func parseCards(_ raw: Any?) -> [QACard] {
        guard let items = raw as? [[String: Any]] else { return [] }
        return items.compactMap { d in
            guard let id    = d["id"]    as? String,
                  let type_ = d["type"]  as? String,
                  let title = d["title"] as? String else { return nil }
            return QACard(
                id: id, type: type_, title: title,
                summary:     d["summary"]     as? String  ?? "",
                details:     d["details"]     as? String  ?? "",
                tags:        d["tags"]        as? [String] ?? [],
                isImportant: d["isImportant"] as? Bool    ?? false
            )
        }
    }

    // Read stdin one byte at a time on a background thread; dispatch complete
    // newline-terminated JSON lines to the main queue for processing.
    private func startStdinReader() {
        Thread.detachNewThread {
            var buf = Data()
            while true {
                let byte = FileHandle.standardInput.readData(ofLength: 1)
                if byte.isEmpty { break }   // EOF = parent Electron process exited
                if byte.first == UInt8(ascii: "\n") {
                    if let line = String(data: buf, encoding: .utf8)?
                            .trimmingCharacters(in: .whitespaces), !line.isEmpty {
                        DispatchQueue.main.async { self.handle(line) }
                    }
                    buf = Data()
                } else {
                    buf.append(byte)
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func handle(_ json: String) {
        guard let data = json.data(using: .utf8),
              let obj  = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = obj["action"] as? String else { return }
        switch action {
        case "show":
            let w: CGFloat = (obj["width"]  as? Double).map { CGFloat($0) } ?? 600
            let h: CGFloat = (obj["height"] as? Double).map { CGFloat($0) } ?? 200
            let sp = obj["screenshotProtected"] as? Bool ?? true
            qaPanel.show(cards: parseCards(obj["cards"]),
                         width: w, height: h, screenshotProtected: sp) {
                self.emitJSON(["type": "dismissed"])
            }
        case "update":
            qaPanel.update(cards: parseCards(obj["cards"]))
        case "screenshot":
            if let on = obj["protected"] as? Bool { qaPanel.setScreenshotProtected(on) }
        case "hide":
            qaPanel.hide()
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }
}

// MARK: - Entry Point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon, no menu bar entry
let appDelegate = AppDelegate()
app.delegate = appDelegate
app.run()
