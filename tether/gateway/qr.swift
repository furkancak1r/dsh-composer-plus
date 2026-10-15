// Usage: swift qr.swift <text> <out.png>  (CoreImage QR, error correction M, 8x)
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write("usage: qr.swift <text> <out.png>\n".data(using: .utf8)!); exit(2) }
let filter = CIFilter.qrCodeGenerator()
filter.message = Data(args[1].utf8)
filter.correctionLevel = "M"
let image = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
try CIContext().writePNGRepresentation(of: image, to: URL(fileURLWithPath: args[2]), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
