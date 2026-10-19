<#
.SYNOPSIS
  Генерирует PNG-иконки 192x192 и 512x512 для PWA.

.DESCRIPTION
  Рисует иконку программно через System.Drawing, без внешних зависимостей.
  Запуск: powershell -ExecutionPolicy Bypass -File .\generate-icons.ps1
#>
param(
  [string]$OutputDir = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

Add-Type -AssemblyName System.Drawing

function New-RoundedPath {
  param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Max(1, $R * 2)
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Icon {
  param([int]$Size, [string]$Path)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $k = $Size / 512.0
  function S([double]$v) { return [float]($v * $k) }

  # Фон с градиентом
  $bgPath = New-RoundedPath -X 0 -Y 0 -W $Size -H $Size -R (S 112)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)),
    (New-Object System.Drawing.PointF($Size, $Size)),
    [System.Drawing.Color]::FromArgb(255, 59, 130, 246),
    [System.Drawing.Color]::FromArgb(255, 29, 78, 216)
  )
  $g.FillPath($bgBrush, $bgPath)
  $bgBrush.Dispose()
  $bgPath.Dispose()

  # Страница календаря
  $pagePath = New-RoundedPath -X (S 96) -Y (S 112) -W (S 320) -H (S 304) -R (S 40)
  $g.FillPath([System.Drawing.Brushes]::White, $pagePath)

  # Шапка календаря
  $headerPath = New-RoundedPath -X (S 96) -Y (S 112) -W (S 320) -H (S 86) -R (S 40)
  $headerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 219, 234, 254))
  $g.FillPath($headerBrush, $headerPath)
  $g.FillRectangle($headerBrush, (S 96), (S 158), (S 320), (S 30))
  $headerBrush.Dispose()

  # Кольца
  $g.FillRectangle([System.Drawing.Brushes]::White, (S 164), (S 80), (S 28), (S 72))
  $g.FillRectangle([System.Drawing.Brushes]::White, (S 320), (S 80), (S 28), (S 72))

  # Ячейки
  $cellBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 147, 197, 253))
  foreach ($rect in @(
      @(144, 248, 56, 40), @(228, 248, 56, 40), @(312, 248, 56, 40),
      @(144, 316, 56, 40), @(228, 316, 140, 40)
    )) {
    $p = New-RoundedPath -X (S $rect[0]) -Y (S $rect[1]) -W (S $rect[2]) -H (S $rect[3]) -R (S 10)
    $g.FillPath($cellBrush, $p)
    $p.Dispose()
  }
  $cellBrush.Dispose()

  # Зелёная галочка
  $g.FillEllipse(
    (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))),
    (S 268), (S 314), (S 184), (S 184)
  )
  $g.FillEllipse(
    (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 163, 74))),
    (S 276), (S 322), (S 168), (S 168)
  )
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, (S 20))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $points = @(
    (New-Object System.Drawing.PointF((S 324), (S 405))),
    (New-Object System.Drawing.PointF((S 350), (S 431))),
    (New-Object System.Drawing.PointF((S 399), (S 380)))
  )
  $g.DrawLines($pen, $points)
  $pen.Dispose()

  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

foreach ($size in @(192, 512)) {
  $path = Join-Path $OutputDir "icon-$size.png"
  New-Icon -Size $size -Path $path
  Write-Host "Создано: $path"
}
