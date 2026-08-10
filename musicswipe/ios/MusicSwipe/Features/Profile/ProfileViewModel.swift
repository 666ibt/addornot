import Foundation

@MainActor
final class ProfileViewModel: ObservableObject {

    @Published private(set) var taste: [TasteGenre] = []
    @Published private(set) var playlists: [PlaylistSummary] = []
    @Published private(set) var likesCount = 0
    @Published private(set) var isLoading = false
    @Published private(set) var isRebuilding = false
    @Published private(set) var errorMessage: String?

    private let repository = MusicRepository()

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            // Запросы независимы — ждём их вместе, а не по очереди.
            async let taste = repository.tasteSummary()
            async let playlists = repository.playlists()
            async let liked = repository.likedTracks(limit: 500)

            self.taste = try await taste
            self.playlists = try await playlists
            self.likesCount = try await liked.count
        } catch {
            errorMessage = (error as? SupabaseError)?.errorDescription ?? error.localizedDescription
        }
    }

    func rebuildProfile() async {
        isRebuilding = true
        errorMessage = nil
        defer { isRebuilding = false }

        do {
            _ = try await repository.rebuildProfile()
            Haptics.notify(.success)
            await load()
        } catch {
            Haptics.notify(.error)
            errorMessage = (error as? SupabaseError)?.errorDescription ?? error.localizedDescription
        }
    }

    func clearError() {
        errorMessage = nil
    }
}
