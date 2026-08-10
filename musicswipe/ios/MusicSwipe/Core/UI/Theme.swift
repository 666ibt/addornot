import SwiftUI

/// Оформление приложения в одном месте.
enum Theme {

    static let background = Color(red: 0.05, green: 0.04, blue: 0.09)
    static let surface = Color(red: 0.11, green: 0.10, blue: 0.16)
    static let surfaceElevated = Color(red: 0.16, green: 0.15, blue: 0.22)

    static let accent = Color(red: 0.99, green: 0.29, blue: 0.45)
    static let accentSecondary = Color(red: 0.53, green: 0.33, blue: 0.98)

    static let like = Color(red: 0.20, green: 0.85, blue: 0.55)
    static let pass = Color(red: 0.98, green: 0.32, blue: 0.36)
    static let superlike = Color(red: 0.30, green: 0.68, blue: 1.00)

    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.65)
    static let textTertiary = Color.white.opacity(0.4)

    static let backgroundGradient = LinearGradient(
        colors: [
            Color(red: 0.09, green: 0.05, blue: 0.18),
            Color(red: 0.05, green: 0.04, blue: 0.09),
            Color(red: 0.12, green: 0.04, blue: 0.14)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let brandGradient = LinearGradient(
        colors: [accentSecondary, accent],
        startPoint: .leading,
        endPoint: .trailing
    )

    static let cardCornerRadius: CGFloat = 28
}

/// Фон, общий для всех экранов.
struct BackgroundView: View {
    var body: some View {
        Theme.backgroundGradient
            .ignoresSafeArea()
            .overlay {
                // Мягкое свечение сверху — карточка на нём читается лучше,
                // чем на плоской заливке.
                RadialGradient(
                    colors: [Theme.accentSecondary.opacity(0.28), .clear],
                    center: .top,
                    startRadius: 0,
                    endRadius: 420
                )
                .ignoresSafeArea()
            }
    }
}

extension View {
    func cardStyle(cornerRadius: CGFloat = 20) -> some View {
        self
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
            }
    }
}
