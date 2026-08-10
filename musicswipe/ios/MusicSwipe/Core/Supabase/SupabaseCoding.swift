import Foundation

/// Кодеры для общения с PostgREST и Edge Functions.
enum SupabaseCoding {

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    /// Для GoTrue и Keychain: там ключи заданы явными CodingKeys,
    /// автоматическое преобразование snake_case только помешает.
    static let plainEncoder = JSONEncoder()
    static let plainDecoder = JSONDecoder()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = parseTimestamp(raw) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Не удалось разобрать дату: \(raw)"
                )
            }
            return date
        }
        return decoder
    }()

    /// Postgres отдаёт микросекунды (`...:00.123456+00:00`), а ISO8601DateFormatter
    /// понимает максимум миллисекунды — поэтому дробную часть подрезаем.
    static func parseTimestamp(_ raw: String) -> Date? {
        let normalized = normalizeFraction(in: raw)

        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: normalized) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: normalized) { return date }

        // Postgres умеет отдавать время без зоны — считаем такие метки UTC.
        let fallback = DateFormatter()
        fallback.locale = Locale(identifier: "en_US_POSIX")
        fallback.timeZone = TimeZone(secondsFromGMT: 0)
        for format in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"] {
            fallback.dateFormat = format
            if let date = fallback.date(from: normalized) { return date }
        }
        return nil
    }

    private static func normalizeFraction(in raw: String) -> String {
        guard let dotIndex = raw.firstIndex(of: ".") else { return raw }

        var digitsEnd = raw.index(after: dotIndex)
        while digitsEnd < raw.endIndex, raw[digitsEnd].isNumber {
            digitsEnd = raw.index(after: digitsEnd)
        }

        let digits = raw[raw.index(after: dotIndex)..<digitsEnd]
        guard digits.count > 3 else { return raw }

        let trimmed = digits.prefix(3)
        return String(raw[raw.startIndex...dotIndex]) + trimmed + String(raw[digitsEnd...])
    }
}
