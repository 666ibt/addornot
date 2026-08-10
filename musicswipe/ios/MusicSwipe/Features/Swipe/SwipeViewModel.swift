import Foundation
import SwiftUI

@MainActor
final class SwipeViewModel: ObservableObject {

    @Published private(set) var cards: [Track] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isRefilling = false
    @Published private(set) var errorMessage: String?

    let player = PreviewPlayer()

    private let repository = MusicRepository()
    private var refillTask: Task<Void, Never>?

    var topCard: Track? { cards.first }

    /// Видимая часть стопки: рисовать больше трёх карточек нет смысла.
    var visibleCards: [Track] { Array(cards.prefix(3)) }

    // MARK: - Загрузка

    func loadInitialDeck() async {
        guard cards.isEmpty, !isLoading else { return }

        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var deck = try await repository.fetchDeck()

            // Пусто на старте — значит, очередь ещё не наполняли.
            if deck.isEmpty {
                isRefilling = true
                _ = try await repository.refillDeck()
                deck = try await repository.fetchDeck()
                isRefilling = false
            }

            cards = deck
            playTopCard()
        } catch {
            isRefilling = false
            errorMessage = message(for: error)
        }
    }

    func retry() async {
        cards = []
        await loadInitialDeck()
    }

    // MARK: - Свайпы

    func swipe(_ direction: SwipeDirection) {
        guard let track = cards.first else { return }

        let listened = player.listenedMs
        cards.removeFirst()
        playTopCard()

        Task { [repository] in
            do {
                try await repository.recordSwipe(
                    trackID: track.id,
                    direction: direction,
                    listenedMs: listened
                )
            } catch {
                // Свайп — не та операция, ради которой стоит прерывать листание.
                // Профиль догонит на следующем: очередь всё равно фильтруется
                // по уже оценённым трекам на сервере.
                print("Не удалось записать свайп: \(error)")
            }
        }

        refillIfNeeded()
    }

    private func refillIfNeeded() {
        guard cards.count <= AppConfig.deckRefillThreshold, refillTask == nil else { return }

        isRefilling = true
        refillTask = Task { [weak self] in
            guard let self else { return }
            defer {
                self.refillTask = nil
                self.isRefilling = false
            }

            do {
                _ = try await self.repository.refillDeck()
                let fresh = try await self.repository.fetchDeck()

                // Пока грузили, пользователь мог свайпнуть ещё — склеиваем без дублей.
                let known = Set(self.cards.map(\.id))
                let added = fresh.filter { !known.contains($0.id) }
                self.cards.append(contentsOf: added)

                if self.player.currentURL == nil { self.playTopCard() }
            } catch {
                self.errorMessage = self.message(for: error)
            }
        }
    }

    // MARK: - Звук

    func playTopCard() {
        player.load(url: cards.first?.previewURL)
    }

    func pausePlayback() {
        player.pause()
    }

    func stopPlayback() {
        player.stop()
    }

    private func message(for error: Error) -> String {
        guard let supabaseError = error as? SupabaseError else { return error.localizedDescription }

        if supabaseError.code == "no_taste_profile" {
            return "Сначала импортируйте плейлист — по нему собирается лента."
        }
        return supabaseError.errorDescription ?? "Что-то пошло не так"
    }
}
