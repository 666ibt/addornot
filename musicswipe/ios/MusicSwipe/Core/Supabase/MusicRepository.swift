import Foundation

/// Единая точка доступа к данным.
///
/// Экраны не знают ни про PostgREST, ни про имена RPC — они работают
/// с методами этого типа.
@MainActor
final class MusicRepository {

    private let client: SupabaseClient

    init(client: SupabaseClient = .shared) {
        self.client = client
    }

    // MARK: - Лента

    func fetchDeck(limit: Int = AppConfig.deckPageSize) async throws -> [Track] {
        try await client.rpc("get_deck", params: ["p_limit": AnyEncodable(limit)])
    }

    func recordSwipe(trackID: UUID, direction: SwipeDirection, listenedMs: Int) async throws {
        try await client.rpcVoid("record_swipe", params: [
            "p_track_id": AnyEncodable(trackID.uuidString),
            "p_direction": AnyEncodable(direction.rawValue),
            "p_listened_ms": AnyEncodable(listenedMs)
        ])
    }

    @discardableResult
    func refillDeck(limit: Int = 30) async throws -> RecommendResult {
        try await client.invoke("recommend", body: ["limit": AnyEncodable(limit)])
    }

    // MARK: - Импорт

    func importPlaylist(url: String) async throws -> ImportPlaylistResult {
        try await client.invoke("import-playlist", body: ["url": AnyEncodable(url)])
    }

    func playlists() async throws -> [PlaylistSummary] {
        try await client.select("playlists", query: [
            URLQueryItem(
                name: "select",
                value: "id,platform,title,cover_url,owner_name,status,track_count,matched_count,error_message,created_at"
            ),
            URLQueryItem(name: "order", value: "created_at.desc"),
            URLQueryItem(name: "limit", value: "20")
        ])
    }

    // MARK: - Профиль и лайки

    func likedTracks(limit: Int = 100, offset: Int = 0) async throws -> [LikedTrack] {
        try await client.rpc("liked_tracks", params: [
            "p_limit": AnyEncodable(limit),
            "p_offset": AnyEncodable(offset)
        ])
    }

    func tasteSummary() async throws -> [TasteGenre] {
        try await client.rpc("taste_summary")
    }

    @discardableResult
    func rebuildProfile() async throws -> RebuildProfileResult {
        try await client.invoke("rebuild-profile")
    }
}

struct RebuildProfileResult: Decodable, Sendable {
    struct Genre: Decodable, Sendable {
        let genre: String
        let weight: Double
    }

    let corpusSize: Int
    let topGenres: [Genre]
    let deckPrepared: Int
}
