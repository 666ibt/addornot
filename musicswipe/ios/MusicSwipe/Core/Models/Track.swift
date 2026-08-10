import Foundation

/// Карточка ленты — то, что возвращает RPC `get_deck`.
struct Track: Decodable, Identifiable, Equatable, Sendable {
    let id: UUID
    let title: String
    let artistName: String
    let albumTitle: String?
    let artworkUrl: String?
    let previewUrl: String?
    let externalUrl: String?
    let durationSec: Int?
    let releaseYear: Int?
    let genres: [String]
    let explicit: Bool
    let score: Double?
    let reason: RecommendationReason?

    var artworkURL: URL? { artworkUrl.flatMap(URL.init(string:)) }
    var previewURL: URL? { previewUrl.flatMap(URL.init(string:)) }
    var externalURL: URL? { externalUrl.flatMap(URL.init(string:)) }

    var subtitle: String {
        [albumTitle, releaseYear.map(String.init)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    static func == (lhs: Track, rhs: Track) -> Bool { lhs.id == rhs.id }
}

/// Почему трек оказался в ленте — показываем это на карточке.
struct RecommendationReason: Decodable, Equatable, Sendable {
    enum Kind: String, Decodable, Sendable {
        case relatedArtist = "related_artist"
        case genreChart = "genre_chart"
        case favouriteArtist = "favourite_artist"
    }

    let kind: Kind?
    let via: String?
    let genres: [String]?

    var displayText: String? {
        switch kind {
        case .relatedArtist:
            guard let via else { return "Похоже на то, что вы слушаете" }
            return "Похоже на \(via)"
        case .genreChart:
            guard let via else { return "Из ваших жанров" }
            return "Из вашего жанра: \(via)"
        case .favouriteArtist:
            return "Любимый исполнитель"
        case nil:
            return nil
        }
    }
}

/// Понравившийся трек — ответ RPC `liked_tracks`.
struct LikedTrack: Decodable, Identifiable, Equatable, Sendable {
    let id: UUID
    let title: String
    let artistName: String
    let albumTitle: String?
    let artworkUrl: String?
    let previewUrl: String?
    let externalUrl: String?
    let durationSec: Int?
    let releaseYear: Int?
    let genres: [String]
    let superliked: Bool
    let likedAt: Date

    var artworkURL: URL? { artworkUrl.flatMap(URL.init(string:)) }
    var previewURL: URL? { previewUrl.flatMap(URL.init(string:)) }
    var externalURL: URL? { externalUrl.flatMap(URL.init(string:)) }

    static func == (lhs: LikedTrack, rhs: LikedTrack) -> Bool { lhs.id == rhs.id }
}

/// Строка сводки вкуса — ответ RPC `taste_summary`.
struct TasteGenre: Decodable, Identifiable, Sendable {
    let genre: String
    let weight: Double

    var id: String { genre }
}

enum SwipeDirection: String, Sendable {
    case like
    case pass
    case superlike
}
