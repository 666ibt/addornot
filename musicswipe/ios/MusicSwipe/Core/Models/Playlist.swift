import Foundation

enum MusicPlatform: String, Decodable, Sendable, CaseIterable {
    case spotify
    case appleMusic = "apple_music"
    case youtube
    case deezer
    case yandex
    case soundcloud

    var displayName: String {
        switch self {
        case .spotify: return "Spotify"
        case .appleMusic: return "Apple Music"
        case .youtube: return "YouTube Music"
        case .deezer: return "Deezer"
        case .yandex: return "Яндекс Музыка"
        case .soundcloud: return "SoundCloud"
        }
    }

    var systemImage: String {
        switch self {
        case .spotify, .deezer, .yandex: return "music.note.list"
        case .appleMusic: return "music.note"
        case .youtube: return "play.rectangle.fill"
        case .soundcloud: return "waveform"
        }
    }

    /// Определение платформы по ссылке — нужно только для подсказки в UI,
    /// решение всё равно принимает сервер.
    static func detect(from urlString: String) -> MusicPlatform? {
        let value = urlString.lowercased()
        if value.contains("spotify.com") || value.hasPrefix("spotify:") { return .spotify }
        if value.contains("music.apple.com") { return .appleMusic }
        if value.contains("youtube.com") || value.contains("youtu.be") { return .youtube }
        if value.contains("deezer.com") || value.contains("deezer.page.link") { return .deezer }
        if value.contains("music.yandex.") { return .yandex }
        if value.contains("soundcloud.com") { return .soundcloud }
        return nil
    }
}

/// Строка таблицы `playlists` (то, что читает экран профиля).
struct PlaylistSummary: Decodable, Identifiable, Sendable {
    let id: UUID
    let platform: MusicPlatform
    let title: String?
    let coverUrl: String?
    let ownerName: String?
    let status: String
    let trackCount: Int
    let matchedCount: Int
    let errorMessage: String?
    let createdAt: Date

    var coverURL: URL? { coverUrl.flatMap(URL.init(string:)) }
    var displayTitle: String { title ?? "Плейлист \(platform.displayName)" }
}

/// Ответ Edge Function `import-playlist`.
struct ImportPlaylistResult: Decodable, Sendable {
    struct Playlist: Decodable, Sendable {
        let id: UUID
        let platform: MusicPlatform
        let title: String?
        let coverUrl: String?
        let ownerName: String?
        let trackCount: Int
        let analyzedCount: Int
        let matchedCount: Int
    }

    struct Taste: Decodable, Sendable {
        struct Genre: Decodable, Sendable {
            let genre: String
            let weight: Double
        }

        let topGenres: [Genre]
        let avgYear: Double?
        let avgBpm: Double?
    }

    let playlist: Playlist
    let taste: Taste
    let deckPrepared: Int
}

/// Ответ Edge Function `recommend`.
struct RecommendResult: Decodable, Sendable {
    let inserted: Int
    let reason: String?
}
