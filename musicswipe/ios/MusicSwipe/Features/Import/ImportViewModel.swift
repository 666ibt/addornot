import Foundation
import SwiftUI
import UIKit

@MainActor
final class ImportViewModel: ObservableObject {

    @Published var url = ""
    @Published private(set) var isImporting = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var result: ImportPlaylistResult?
    @Published private(set) var progressStage = ImportViewModel.stages[0]

    private let repository = MusicRepository()
    private var stageTask: Task<Void, Never>?

    /// Импорт идёт одним запросом и занимает десятки секунд. Прогресс-бар был бы
    /// обманом, поэтому показываем, чем сервер занят прямо сейчас — по таймингам,
    /// которые повторяют шаги Edge Function.
    private static let stages = [
        "Открываем плейлист…",
        "Читаем список треков…",
        "Ищем треки в музыкальном каталоге…",
        "Определяем жанры и годы…",
        "Собираем ваш вкусовой профиль…",
        "Подбираем первые рекомендации…"
    ]

    var detectedPlatform: MusicPlatform? {
        MusicPlatform.detect(from: url)
    }

    var canImport: Bool {
        !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isImporting
    }

    func pasteFromClipboard() {
        guard let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return }
        url = text
    }

    func clearError() {
        errorMessage = nil
    }

    func importPlaylist() async {
        let link = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty else { return }

        isImporting = true
        errorMessage = nil
        result = nil
        startStageAnimation()

        defer {
            isImporting = false
            stageTask?.cancel()
            stageTask = nil
        }

        do {
            result = try await repository.importPlaylist(url: link)
            Haptics.notify(.success)
        } catch {
            Haptics.notify(.error)
            errorMessage = (error as? SupabaseError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func startStageAnimation() {
        stageTask?.cancel()
        progressStage = Self.stages[0]

        stageTask = Task { [weak self] in
            for stage in Self.stages.dropFirst() {
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.progressStage = stage }
            }
        }
    }
}
