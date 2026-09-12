import MapKit
import SwiftUI

struct MapView: View {
    let path: [PathPoint]

    private var coordinates: [CLLocationCoordinate2D] {
        path.map { CLLocationCoordinate2D(latitude: $0.y, longitude: $0.x) }
    }

    var body: some View {
        Map {
            if coordinates.count > 1 {
                MapPolyline(coordinates: coordinates)
                    .stroke(.blue, lineWidth: 5)
            }
        }
        .mapStyle(.standard)
        .overlay(alignment: .topLeading) {
            Text("Indoor walk map")
                .font(.headline)
                .padding(10)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                .padding()
        }
    }
}
