import SwiftUI

@main
struct MusicSwipeApp: App {

    @StateObject private var client = SupabaseClient.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(client)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}
