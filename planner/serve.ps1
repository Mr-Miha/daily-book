<#
.SYNOPSIS
  Мини-сервер статических файлов для локального запуска ежедневника.

.DESCRIPTION
  Запускает HTTP-сервер на http://localhost:<порт>/ .
  Нужен, потому что service worker, установка PWA и уведомления
  работают только по http(s), а не по file://.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\serve.ps1
  powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 8080
#>
param(
  [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

# Корень — папка, где лежит этот скрипт.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path -LiteralPath $root).Path

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host "Не удалось запустить сервер на $prefix" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Возможно, порт занят. Попробуйте другой: -Port 8080" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "  Ежедневник запущен:  $prefix" -ForegroundColor Green
Write-Host "  Папка:               $root" -ForegroundColor DarkGray
Write-Host "  Остановить:          Ctrl+C" -ForegroundColor DarkGray
Write-Host ""

$mime = @{
  ".html"        = "text/html; charset=utf-8"
  ".htm"         = "text/html; charset=utf-8"
  ".css"         = "text/css; charset=utf-8"
  ".js"          = "text/javascript; charset=utf-8"
  ".json"        = "application/json; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
  ".svg"         = "image/svg+xml"
  ".png"         = "image/png"
  ".ico"         = "image/x-icon"
  ".txt"         = "text/plain; charset=utf-8"
  ".md"          = "text/markdown; charset=utf-8"
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $relative = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart("/"))
    if ([string]::IsNullOrWhiteSpace($relative)) { $relative = "index.html" }

    $candidate = Join-Path $root $relative
    $resolved = $null

    try {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $resolved = (Resolve-Path -LiteralPath $candidate).Path
      } elseif (Test-Path -LiteralPath $candidate -PathType Container) {
        $index = Join-Path $candidate "index.html"
        if (Test-Path -LiteralPath $index -PathType Leaf) {
          $resolved = (Resolve-Path -LiteralPath $index).Path
        }
      }
    } catch { }

    # Защита от выхода за пределы каталога проекта.
    if ($resolved -and -not $resolved.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $resolved = $null
    }

    if (-not $resolved) {
      $response.StatusCode = 404
      $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 — файл не найден")
      $response.ContentType = "text/plain; charset=utf-8"
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
      $response.Close()
      continue
    }

    $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
    $response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
    $response.Headers["Cache-Control"] = "no-store"

    try {
      $bytes = [System.IO.File]::ReadAllBytes($resolved)
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      $response.StatusCode = 500
    } finally {
      $response.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
