import Foundation

/// Минималистичный клиент Supabase на URLSession.
///
/// Приложение использует три вещи: GoTrue (вход), PostgREST (таблицы и RPC)
/// и Edge Functions. Всё это — обычный HTTP, поэтому вместо внешней зависимости
/// здесь свой тонкий слой: сборка запроса, подстановка токена и его обновление.
///
/// Изоляция на главном акторе выбрана осознанно: сессия — это состояние,
/// на которое подписан весь UI, и держать её в одном месте проще, чем
/// синхронизировать доступ из нескольких потоков.
@MainActor
final class SupabaseClient: ObservableObject {

    static let shared = SupabaseClient()

    @Published private(set) var session: SupabaseSession?
    @Published private(set) var isRestoring = true

    let config: SupabaseConfig?

    private let urlSession: URLSession
    private var refreshTask: Task<SupabaseSession, Error>?

    private static let sessionKey = "supabase.session"

    var isConfigured: Bool { config != nil }
    var currentUserID: UUID? { session?.user.id }

    init(config: SupabaseConfig? = AppConfig.supabase) {
        self.config = config

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        // Импорт плейлиста ходит во внешние API и легко занимает полминуты.
        configuration.timeoutIntervalForResource = 180
        configuration.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: configuration)
    }

    // MARK: - Сессия

    func restoreSession() async {
        defer { isRestoring = false }

        guard config != nil,
              let data = KeychainStore.load(key: Self.sessionKey),
              let stored = try? SupabaseCoding.plainDecoder.decode(SupabaseSession.self, from: data)
        else {
            return
        }

        session = stored

        guard stored.needsRefresh else { return }

        do {
            _ = try await refreshSession()
        } catch {
            // Refresh-токен протух или отозван — просим войти заново.
            clearSession()
        }
    }

    private func store(_ newSession: SupabaseSession) {
        session = newSession
        if let data = try? SupabaseCoding.plainEncoder.encode(newSession) {
            KeychainStore.save(data, key: Self.sessionKey)
        }
    }

    private func clearSession() {
        session = nil
        KeychainStore.delete(key: Self.sessionKey)
    }

    /// Токен, гарантированно живой на момент вызова.
    func validAccessToken() async throws -> String {
        guard let session else { throw SupabaseError.notAuthenticated }
        guard session.needsRefresh else { return session.accessToken }
        return try await refreshSession().accessToken
    }

    /// Обновление токена. Параллельные вызовы ждут один и тот же запрос —
    /// иначе несколько экранов разом сожгут refresh-токен при ротации.
    @discardableResult
    private func refreshSession() async throws -> SupabaseSession {
        if let refreshTask {
            return try await refreshTask.value
        }

        guard let session else { throw SupabaseError.notAuthenticated }

        let task = Task<SupabaseSession, Error> { [weak self] in
            guard let self else { throw SupabaseError.notAuthenticated }
            let response: AuthResponse = try await self.authRequest(
                path: "token",
                query: [URLQueryItem(name: "grant_type", value: "refresh_token")],
                body: ["refresh_token": session.refreshToken]
            )
            guard let refreshed = response.session() else {
                throw SupabaseError.notAuthenticated
            }
            return refreshed
        }

        refreshTask = task

        do {
            let refreshed = try await task.value
            refreshTask = nil
            store(refreshed)
            return refreshed
        } catch {
            refreshTask = nil
            throw error
        }
    }

    // MARK: - Аутентификация

    func signUp(email: String, password: String) async throws {
        let response: AuthResponse = try await authRequest(
            path: "signup",
            body: ["email": email, "password": password]
        )

        guard let newSession = response.session() else {
            // Так бывает при включённом подтверждении e-mail.
            throw SupabaseError.api(
                status: 200,
                message: "Аккаунт создан. Подтвердите адрес по ссылке из письма и войдите.",
                code: "email_confirmation_required"
            )
        }
        store(newSession)
    }

    func signIn(email: String, password: String) async throws {
        let response: AuthResponse = try await authRequest(
            path: "token",
            query: [URLQueryItem(name: "grant_type", value: "password")],
            body: ["email": email, "password": password]
        )

        guard let newSession = response.session() else {
            throw SupabaseError.notAuthenticated
        }
        store(newSession)
    }

    /// Анонимный вход: даёт полноценный user_id, поэтому RLS и рекомендации
    /// работают без регистрации. Аккаунт потом можно привязать к почте.
    func signInAnonymously() async throws {
        let response: AuthResponse = try await authRequest(path: "signup", body: [:] as [String: String])

        guard let newSession = response.session() else {
            throw SupabaseError.api(
                status: 422,
                message: "Анонимный вход выключен в настройках проекта Supabase.",
                code: "anonymous_disabled"
            )
        }
        store(newSession)
    }

    func signOut() async {
        if let token = session?.accessToken, let config {
            var request = URLRequest(url: config.authURL.appendingPathComponent("logout"))
            request.httpMethod = "POST"
            request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            _ = try? await urlSession.data(for: request)
        }
        clearSession()
    }

    // MARK: - PostgREST

    /// Вызов SQL-функции. Вся бизнес-логика чтения живёт в RPC — так клиенту
    /// не нужно знать про join'ы и фильтры по auth.uid().
    func rpc<Response: Decodable>(
        _ function: String,
        params: [String: AnyEncodable] = [:],
        as type: Response.Type = Response.self
    ) async throws -> Response {
        guard let config else { throw SupabaseError.notConfigured }

        var request = URLRequest(url: config.restURL.appendingPathComponent("rpc/\(function)"))
        request.httpMethod = "POST"
        request.httpBody = try SupabaseCoding.encoder.encode(params)

        return try await performAuthenticated(request, decoder: SupabaseCoding.decoder)
    }

    /// Вызов RPC без ответа (`returns void`).
    func rpcVoid(_ function: String, params: [String: AnyEncodable] = [:]) async throws {
        guard let config else { throw SupabaseError.notConfigured }

        var request = URLRequest(url: config.restURL.appendingPathComponent("rpc/\(function)"))
        request.httpMethod = "POST"
        request.httpBody = try SupabaseCoding.encoder.encode(params)

        _ = try await performAuthenticatedRaw(request)
    }

    func select<Response: Decodable>(
        _ table: String,
        query: [URLQueryItem],
        as type: Response.Type = Response.self
    ) async throws -> Response {
        guard let config else { throw SupabaseError.notConfigured }

        var components = URLComponents(
            url: config.restURL.appendingPathComponent(table),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = query

        guard let url = components?.url else { throw SupabaseError.notConfigured }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"

        return try await performAuthenticated(request, decoder: SupabaseCoding.decoder)
    }

    // MARK: - Edge Functions

    func invoke<Response: Decodable>(
        _ function: String,
        body: [String: AnyEncodable] = [:],
        as type: Response.Type = Response.self
    ) async throws -> Response {
        guard let config else { throw SupabaseError.notConfigured }

        var request = URLRequest(url: config.functionsURL.appendingPathComponent(function))
        request.httpMethod = "POST"
        request.httpBody = try SupabaseCoding.encoder.encode(body)

        return try await performAuthenticated(request, decoder: SupabaseCoding.decoder)
    }

    // MARK: - Транспорт

    private func authRequest<Response: Decodable>(
        path: String,
        query: [URLQueryItem] = [],
        body: [String: String]
    ) async throws -> Response {
        guard let config else { throw SupabaseError.notConfigured }

        var components = URLComponents(
            url: config.authURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = query.isEmpty ? nil : query

        guard let url = components?.url else { throw SupabaseError.notConfigured }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try SupabaseCoding.plainEncoder.encode(body)
        request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let data = try await send(request)

        do {
            return try SupabaseCoding.plainDecoder.decode(Response.self, from: data)
        } catch {
            throw SupabaseError.decoding(error)
        }
    }

    private func performAuthenticated<Response: Decodable>(
        _ request: URLRequest,
        decoder: JSONDecoder
    ) async throws -> Response {
        let data = try await performAuthenticatedRaw(request)

        if data.isEmpty, let empty = EmptyResponse() as? Response {
            return empty
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw SupabaseError.decoding(error)
        }
    }

    private func performAuthenticatedRaw(_ request: URLRequest) async throws -> Data {
        guard let config else { throw SupabaseError.notConfigured }

        func authorized(with token: String) -> URLRequest {
            var copy = request
            copy.setValue(config.anonKey, forHTTPHeaderField: "apikey")
            copy.setValue("application/json", forHTTPHeaderField: "Content-Type")
            copy.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return copy
        }

        let token = try await validAccessToken()

        do {
            return try await send(authorized(with: token))
        } catch let error as SupabaseError where error.isUnauthorized {
            // Токен мог протухнуть между проверкой и отправкой — один повтор.
            let refreshed = try await refreshSession()
            return try await send(authorized(with: refreshed.accessToken))
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw SupabaseError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw SupabaseError.decoding(URLError(.badServerResponse))
        }

        guard (200..<300).contains(http.statusCode) else {
            let parsed = Self.parseError(data: data, status: http.statusCode)
            throw SupabaseError.api(status: http.statusCode, message: parsed.message, code: parsed.code)
        }

        return data
    }

    /// Три сервиса — три формата ошибок. Приводим их к одному виду.
    private static func parseError(data: Data, status: Int) -> (message: String, code: String?) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return (defaultMessage(for: status), nil)
        }

        // Edge Function: { "error": { "code": ..., "message": ... } }
        if let nested = json["error"] as? [String: Any] {
            let message = nested["message"] as? String ?? defaultMessage(for: status)
            return (message, nested["code"] as? String)
        }

        // PostgREST: { "message": ..., "code": ..., "hint": ... }
        if let message = json["message"] as? String {
            return (message, json["code"] as? String)
        }

        // GoTrue: { "error": "...", "error_description": ... } / { "msg": ... }
        if let description = json["error_description"] as? String {
            return (description, json["error"] as? String)
        }
        if let msg = json["msg"] as? String {
            return (msg, json["error_code"] as? String)
        }
        if let message = json["error"] as? String {
            return (message, nil)
        }

        return (defaultMessage(for: status), nil)
    }

    private static func defaultMessage(for status: Int) -> String {
        switch status {
        case 401: return "Сессия истекла — войдите заново."
        case 403: return "Недостаточно прав для этого действия."
        case 404: return "Ресурс не найден."
        case 409: return "Действие сейчас недоступно."
        case 429: return "Слишком много запросов, попробуйте через минуту."
        case 500...599: return "Сервер не отвечает, попробуйте позже."
        default: return "Запрос не удался (код \(status))."
        }
    }
}

/// Заглушка для запросов без тела ответа.
struct EmptyResponse: Codable {}

/// Стирание типа для параметров RPC: значения бывают строками, числами и UUID.
struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init<T: Encodable>(_ value: T) {
        encodeValue = { encoder in
            var container = encoder.singleValueContainer()
            try container.encode(value)
        }
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}
