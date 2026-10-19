<#
.SYNOPSIS
  Генерирует звук карканья вороны: sounds/crow.wav

.DESCRIPTION
  Синтезирует «кар-кар» программно (без внешних файлов и зависимостей):
  две хриплые вскрика с падающей частотой, шумом и дребезгом.
  Формат: WAV, PCM 16 бит, моно, 22050 Гц.

  Запуск: powershell -ExecutionPolicy Bypass -File .\generate-sound.ps1

  Если захотите заменить звук на настоящую запись — просто положите
  свой файл crow.wav (или crow.mp3) рядом и поправьте путь в app.js.
#>
param(
  [string]$OutputPath = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "crow.wav")
)

$ErrorActionPreference = "Stop"

$sampleRate = 22050
$totalSeconds = 0.95
$totalSamples = [int]($totalSeconds * $sampleRate)

# Два карка: начало, длительность, начальная и конечная частота (Гц)
$caws = @(
  @{ Start = 0.02; Dur = 0.34; F0 = 860; F1 = 420 },
  @{ Start = 0.50; Dur = 0.31; F0 = 800; F1 = 390 }
)

$samples = New-Object 'double[]' $totalSamples
$rnd = New-Object System.Random(20261019)

foreach ($caw in $caws) {
  $offset = [int]($caw.Start * $sampleRate)
  $n = [int]($caw.Dur * $sampleRate)
  $phase = 0.0
  # лёгкий случайный «дребезг» голосовых связок
  $jitter = 0.0

  for ($i = 0; $i -lt $n; $i++) {
    $t = $i / $sampleRate
    $u = $t / $caw.Dur

    # Частота падает: так вороны «гавкают» вниз
    $f = $caw.F0 + ($caw.F1 - $caw.F0) * [Math]::Pow($u, 0.75)
    $jitter = 0.92 * $jitter + 0.08 * ($rnd.NextDouble() * 2 - 1)
    $f = $f * (1.0 + 0.05 * $jitter)

    $phase += 2 * [Math]::PI * $f / $sampleRate

    # Гармоники — дают резкий «скрипучий» тембр
    $tone = 0.0
    for ($h = 1; $h -le 10; $h++) {
      $tone += [Math]::Sin($phase * $h + $h * 0.6) / $h
    }
    $tone /= 2.0

    # Амплитудная модуляция — «рашпиль», характерный для карканья
    $tone *= 0.70 + 0.30 * [Math]::Sin(2 * [Math]::PI * 128 * $t)

    # Шумовая составляющая — хрип
    $noise = $rnd.NextDouble() * 2 - 1
    $value = 0.60 * $tone + 0.40 * $noise * 0.85

    # Огибающая: быстрая атака, затухание
    $attack = [Math]::Min(1.0, $t / 0.018)
    $decay = [Math]::Exp(-3.1 * [Math]::Pow($u, 1.25))
    $env = $attack * $decay

    $idx = $offset + $i
    if ($idx -ge 0 -and $idx -lt $totalSamples) {
      $samples[$idx] += $value * $env
    }
  }
}

# Мягкий фейд по краям записи, чтобы не было щелчков
$fade = [int](0.004 * $sampleRate)
for ($i = 0; $i -lt $fade; $i++) {
  $k = $i / $fade
  $samples[$i] *= $k
  $samples[$totalSamples - 1 - $i] *= $k
}

# Нормализация по пику
$peak = 0.0
foreach ($s in $samples) { if ([Math]::Abs($s) -gt $peak) { $peak = [Math]::Abs($s) } }
$gain = if ($peak -gt 0) { 0.92 / $peak } else { 1.0 }

# Запись WAV (PCM 16 бит, моно)
$dir = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$dataBytes = $totalSamples * 2
$stream = [System.IO.File]::Create($OutputPath)
$writer = New-Object System.IO.BinaryWriter($stream)

$writer.Write([char[]]"RIFF")
$writer.Write([int](36 + $dataBytes))
$writer.Write([char[]]"WAVE")
$writer.Write([char[]]"fmt ")
$writer.Write([int]16)             # размер блока fmt
$writer.Write([int16]1)            # PCM
$writer.Write([int16]1)            # моно
$writer.Write([int]$sampleRate)
$writer.Write([int]($sampleRate * 2))  # байт в секунду
$writer.Write([int16]2)            # выравнивание блока
$writer.Write([int16]16)           # бит на сэмпл
$writer.Write([char[]]"data")
$writer.Write([int]$dataBytes)

foreach ($s in $samples) {
  $v = [Math]::Round($s * $gain * 32767)
  if ($v -gt 32767) { $v = 32767 }
  if ($v -lt -32768) { $v = -32768 }
  $writer.Write([int16]$v)
}

$writer.Flush()
$writer.Close()
$stream.Close()

Write-Host "Создано: $OutputPath"
Write-Host ("Длительность: {0:N2} с, частота: {1} Гц, пик после нормализации: {2:N2}" -f $totalSeconds, $sampleRate, $gain)
