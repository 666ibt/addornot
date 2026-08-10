import SwiftUI
import UIKit

/// Обложка с плейсхолдером и плавным появлением.
struct ArtworkView: View {
    let url: URL?
    var cornerRadius: CGFloat = 12

    var body: some View {
        AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFill()
            case .failure:
                placeholder(systemImage: "music.note")
            case .empty:
                placeholder(systemImage: "music.note")
                    .overlay { ProgressView().tint(Theme.textTertiary) }
            @unknown default:
                placeholder(systemImage: "music.note")
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private func placeholder(systemImage: String) -> some View {
        ZStack {
            LinearGradient(
                colors: [Theme.surfaceElevated, Theme.surface],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Theme.textTertiary)
        }
    }
}

/// Основная кнопка с индикатором загрузки.
struct PrimaryButton: View {
    let title: String
    var systemImage: String?
    var isLoading = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView().tint(.white)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .foregroundStyle(.white)
            .background(Theme.brandGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .opacity(isEnabled && !isLoading ? 1 : 0.55)
        }
        .disabled(!isEnabled || isLoading)
    }
}

/// Плашка с ошибкой.
struct ErrorBanner: View {
    let message: String
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)

            if let onRetry {
                Button("Попробовать снова", action: onRetry)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.pass.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.pass.opacity(0.35), lineWidth: 1)
        }
    }
}

/// Чип с жанром.
struct GenreChip: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay { Capsule().strokeBorder(Color.white.opacity(0.15), lineWidth: 1) }
    }
}

/// Заглушка для пустых состояний.
struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.accent)

            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 12)
                    .background(Theme.brandGradient, in: Capsule())
                    .padding(.top, 4)
            }
        }
        .padding(28)
    }
}

/// Тактильная отдача на действия со свайпом.
enum Haptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }
}

extension Int {
    /// 214 -> «3:34»
    var asDuration: String {
        let minutes = self / 60
        let seconds = self % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}
