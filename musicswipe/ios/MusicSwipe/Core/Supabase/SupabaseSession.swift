import Foundation

struct SupabaseUser: Codable, Sendable, Identifiable, Equatable {
    let id: UUID
    let email: String?
    let isAnonymous: Bool

    private enum CodingKeys: String, CodingKey {
        case id, email
        case isAnonymous = "is_anonymous"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        email = try container.decodeIfPresent(String.self, forKey: .email)
        isAnonymous = try container.decodeIfPresent(Bool.self, forKey: .isAnonymous) ?? false
    }

    init(id: UUID, email: String?, isAnonymous: Bool) {
        self.id = id
        self.email = email
        self.isAnonymous = isAnonymous
    }
}

struct SupabaseSession: Codable, Sendable, Equatable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: Date
    var user: SupabaseUser

    /// Обновляемся заранее: живой токен ценнее лишнего запроса.
    var needsRefresh: Bool {
        expiresAt.timeIntervalSinceNow < 60
    }
}

/// Ответ GoTrue на /token, /signup и /user.
struct AuthResponse: Decodable {
    let accessToken: String?
    let refreshToken: String?
    let expiresIn: Int?
    let user: SupabaseUser?

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
        case user
    }

    func session() -> SupabaseSession? {
        guard let accessToken, let refreshToken, let user else { return nil }
        return SupabaseSession(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(expiresIn ?? 3600)),
            user: user
        )
    }
}
