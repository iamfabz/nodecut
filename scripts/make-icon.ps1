# NodeCut's icon (a browser frame with a play triangle), drawn with Windows' own System.Drawing and packed as PNG-in-ICO.
#   powershell -NoProfile -File scripts\make-icon.ps1 <out.ico>     (setup.ps1 writes datapp.ico for the Desktop shortcut)
#
# The shape mirrors ui/icon.svg: a dark rounded tile, a cyan frame with a title bar and four ticks, and a white play
# triangle between two hairline rails. Drawn in code so Windows builds need nothing extra installed.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($r * 2)
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconPng([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)

  # the tile: a dark rounded square, the whole canvas
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 10, 10, 12))), (New-RoundedPath 0 0 $s $s ($s * 0.219)))

  $cyan = [System.Drawing.Color]::FromArgb(255, 56, 189, 248)   # --accent-primary #38bdf8
  $rail = [System.Drawing.Color]::FromArgb(255, 125, 216, 253)   # #7dd8fd
  $ink  = [System.Drawing.Color]::FromArgb(255, 10, 10, 12)      # --canvas #0a0a0c

  # the frame: 74x58 of a 128 grid, at x=27 y=35
  $fx = [single]($s * 27 / 128); $fy = [single]($s * 35 / 128)
  $fw = [single]($s * 74 / 128); $fh = [single]($s * 58 / 128)
  $fr = [single]($s * 5.5 / 128); $lw = [single]([Math]::Max(1.0, $s * 3.4 / 128))
  $frame = New-RoundedPath $fx $fy $fw $fh $fr
  $g.FillPath((New-Object System.Drawing.SolidBrush $ink), $frame)
  $g.DrawPath((New-Object System.Drawing.Pen $cyan, $lw), $frame)

  # the title bar
  $bar = [single]($s * 46.5 / 128)
  $g.DrawLine((New-Object System.Drawing.Pen $cyan, ([single]([Math]::Max(0.8, $s * 2.6 / 128)))), $fx, $bar, ($fx + $fw), $bar)

  # the four ticks above it
  $tickPen = New-Object System.Drawing.Pen $rail, ([single]([Math]::Max(0.8, $s * 2.2 / 128)))
  $tickPen.StartCap = 'Round'; $tickPen.EndCap = 'Round'
  foreach ($tx in 46.5, 61, 75.5, 90) {
    $x = [single]($s * $tx / 128)
    $g.DrawLine($tickPen, $x, [single]($s * 39.2 / 128), $x, [single]($s * 43.4 / 128))
  }

  # the play triangle
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tri.AddPolygon(@(
    (New-Object System.Drawing.PointF ([single]($s * 57 / 128)), ([single]($s * 55.5 / 128))),
    (New-Object System.Drawing.PointF ([single]($s * 74.5 / 128)), ([single]($s * 66 / 128))),
    (New-Object System.Drawing.PointF ([single]($s * 57 / 128)), ([single]($s * 76.5 / 128)))
  ))
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $tri)

  # the two hairline rails either side of it
  $railPen = New-Object System.Drawing.Pen $rail, ([single]([Math]::Max(0.8, $s * 2.2 / 128)))
  $railPen.StartCap = 'Round'; $railPen.EndCap = 'Round'
  foreach ($rx in 45.5, 83) {
    $x = [single]($s * $rx / 128)
    $g.DrawLine($railPen, $x, [single]($s * 55.5 / 128), $x, [single]($s * 76.5 / 128))
  }

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return , $ms.ToArray()
}
$sizes = 256, 48, 32, 16
$pngs = $sizes | ForEach-Object { , (New-IconPng $_) }
$ico = New-Object System.IO.MemoryStream; $bw = New-Object System.IO.BinaryWriter $ico
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$off = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]; $b = if ($sz -ge 256) { 0 } else { $sz }
  $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$off)
  $off += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null
[System.IO.File]::WriteAllBytes($Out, $ico.ToArray())
