# Resizes a photo the way the app does before a scan (longest side 3200 px,
# aspect kept), so the corpus can hold exactly what the parser received.
#   powershell -File scripts/resize-like-app.ps1 <input.jpg> <output.jpg>
param([string]$InputPath, [string]$OutputPath)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile((Resolve-Path $InputPath))
try {
  # Apply the EXIF orientation first, as the app does (a phone photo is often
  # stored sideways with a flag saying how to turn it).
  if ($img.PropertyIdList -contains 0x0112) {
    $o = [BitConverter]::ToUInt16($img.GetPropertyItem(0x0112).Value, 0)
    switch ($o) {
      3 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
      6 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
      8 { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    }
  }
  $scale = 3200 / [Math]::Max($img.Width, $img.Height)
  if ($scale -gt 1) { $scale = 1 }
  $w = [int][Math]::Round($img.Width * $scale); $h = [int][Math]::Round($img.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $w, $h)
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
  $bmp.Save($OutputPath, $codec, $params)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "resized $($img.Width)x$($img.Height) -> ${w}x${h}"
} finally { $img.Dispose() }
