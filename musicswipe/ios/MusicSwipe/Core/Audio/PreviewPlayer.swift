import AVFoundation
import Combine
import Foundation

/// Проигрыватель 30-секундных превью.
///
/// Одна карточка — один трек, поэтому плеер держит ровно один AVPlayer
/// и переиспользует его: пересоздание на каждый свайп даёт слышимую задержку.
///
/// Поля AVPlayer помечены `nonisolated(unsafe)` намеренно: их нужно освободить
/// в `deinit`, который всегда неизолирован, а незакрытый periodic time observer
/// роняет приложение при освобождении плеера.
@MainActor
final class PreviewPlayer: ObservableObject {

    @Published private(set) var isPlaying = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var isBuffering = false
    @Published private(set) var currentURL: URL?

    /// Сколько миллисекунд трек реально звучал. Отправляем вместе со свайпом:
    /// «пролистал через две секунды» и «дослушал до конца» — разные сигналы.
    private(set) var listenedMs: Int = 0

    nonisolated(unsafe) private let player = AVPlayer()
    nonisolated(unsafe) private var timeObserver: Any?
    nonisolated(unsafe) private var endObserver: NSObjectProtocol?

    private var statusObservation: NSKeyValueObservation?
    private var lastTickAt: Date?

    init() {
        player.actionAtItemEnd = .none
        configureAudioSession()
        addTimeObserver()
    }

    deinit {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
    }

    // MARK: - Управление

    func load(url: URL?, autoplay: Bool = true) {
        guard currentURL != url else {
            if autoplay { resume() }
            return
        }

        unloadItem()
        currentURL = url
        listenedMs = 0
        progress = 0

        guard let url else {
            isPlaying = false
            return
        }

        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)

        isBuffering = true
        statusObservation = item.observe(\.status, options: [.new]) { item, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if item.status != .unknown { self.isBuffering = false }
            }
        }

        observeEnd(of: item)

        if autoplay { resume() }
    }

    func resume() {
        guard player.currentItem != nil else { return }
        lastTickAt = Date()
        player.play()
        isPlaying = true
    }

    func pause() {
        accumulateListened()
        player.pause()
        isPlaying = false
        lastTickAt = nil
    }

    func toggle() {
        isPlaying ? pause() : resume()
    }

    func stop() {
        unloadItem()
        currentURL = nil
        progress = 0
        isPlaying = false
    }

    // MARK: - Внутреннее

    private func unloadItem() {
        accumulateListened()
        player.pause()
        player.replaceCurrentItem(with: nil)

        statusObservation?.invalidate()
        statusObservation = nil

        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }

        isBuffering = false
        lastTickAt = nil
    }

    private func configureAudioSession() {
        do {
            // .playback — чтобы превью звучало и при включённом «беззвучном» режиме.
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Без звука приложение всё ещё работоспособно — просто молчит.
            print("Не удалось настроить аудиосессию: \(error)")
        }
    }

    private func addTimeObserver() {
        let interval = CMTime(seconds: 0.1, preferredTimescale: CMTimeScale(NSEC_PER_SEC))

        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                guard let duration = self.player.currentItem?.duration.seconds,
                      duration.isFinite, duration > 0 else { return }
                self.progress = min(max(time.seconds / duration, 0), 1)
                self.accumulateListened()
            }
        }
    }

    /// Превью короткое, поэтому по окончании крутим его заново —
    /// пользователь успевает распробовать трек, пока думает над свайпом.
    private func observeEnd(of item: AVPlayerItem) {
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.player.seek(to: .zero)
                if self.isPlaying { self.player.play() }
            }
        }
    }

    /// Копит фактическое время звучания между тиками таймера.
    private func accumulateListened() {
        guard isPlaying else { return }

        guard let lastTickAt else {
            self.lastTickAt = Date()
            return
        }

        let elapsed = Date().timeIntervalSince(lastTickAt)
        if elapsed > 0 {
            listenedMs += Int(elapsed * 1000)
        }
        self.lastTickAt = Date()
    }
}
