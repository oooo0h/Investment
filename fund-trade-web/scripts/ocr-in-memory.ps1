param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [double]$Scale = 1,
    [double]$LeftFraction = 0
)
$ErrorActionPreference = 'Stop'
$stage = 'runtime'
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and
        $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await-Operation($Operation, [Type]$ResultType) {
        $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        $task.Wait()
        return $task.Result
    }
    $stage = 'open-storage-file'
    $imageBytes = [System.IO.File]::ReadAllBytes($ImagePath)
    $stage = 'open-stream'
    $memoryStream = New-Object System.IO.MemoryStream(,$imageBytes)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memoryStream)
    $stage = 'create-decoder'
    $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $stage = 'create-engine'
    $language = New-Object Windows.Globalization.Language 'zh-Hans-CN'
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) { throw 'OCR language unavailable' }
    $width = [uint32][Math]::Round($decoder.PixelWidth * $Scale)
    $height = [uint32][Math]::Round($decoder.PixelHeight * $Scale)
    $left = [uint32][Math]::Round($width * $LeftFraction)
    $cropWidth = $width - $left
    if ($cropWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) { throw 'Image width exceeds OCR limit' }
    $lines = New-Object System.Collections.Generic.List[object]
    $chunkHeight = [Math]::Min(3000, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
    $overlap = 180
    for ($top = 0; $top -lt $height; $top += ($chunkHeight - $overlap)) {
        $stage = 'decode-tile'
        $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
        $transform.ScaledWidth = $width
        $transform.ScaledHeight = $height
        $bounds = New-Object Windows.Graphics.Imaging.BitmapBounds
        $bounds.X = $left
        $bounds.Y = [uint32]$top
        $bounds.Width = $cropWidth
        $bounds.Height = [uint32][Math]::Min($chunkHeight, $height - $top)
        $transform.Bounds = $bounds
        $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync(
            [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
            $transform,
            [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
            [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
        )) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $stage = 'recognize-tile'
            $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            foreach ($line in $result.Lines) {
                $words = @($line.Words | ForEach-Object {
                    @{ text = $_.Text; x = ($_.BoundingRect.X + $left) / $Scale; y = ($_.BoundingRect.Y + $top) / $Scale;
                       width = $_.BoundingRect.Width / $Scale; height = $_.BoundingRect.Height / $Scale }
                })
                $lines.Add(@{ text = $line.Text; words = $words })
            }
        } finally { $bitmap.Dispose() }
        if ($top + $chunkHeight -ge $height) { break }
    }
    $stream.Dispose()
    $stage = 'serialize-memory-result'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    @{ lines = $lines.ToArray() } | ConvertTo-Json -Depth 8 -Compress
} catch {
    [Console]::Error.WriteLine('Local OCR failed at ' + $stage + ' (' + $_.Exception.GetType().Name + '). No recognized content was emitted.')
    exit 1
}
