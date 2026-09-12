import Foundation

enum NetworkError: Error {
    case invalidResponse
    case server(statusCode: Int)
}

final class NetworkManager {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = URL(string: "http://localhost:5000")!, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func upload(_ walk: Walk) async throws {
        let endpoint = baseURL.appendingPathComponent("api/walks")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(walk)

        let (_, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NetworkError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw NetworkError.server(statusCode: httpResponse.statusCode)
        }
    }
}
