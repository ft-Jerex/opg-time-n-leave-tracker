param(
  [string]$TemplatePath = 'C:\Users\FPI - Je\Downloads\Automation Projects Playbook.docx',
  [string]$MarkdownPath = (Join-Path $PSScriptRoot '..\docs\time-leave-tracker-user-playbook.md'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\docs\Time-and-Leave-Tracker-User-Playbook.docx')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

function Escape-Xml([string]$Value) {
  return [System.Security.SecurityElement]::Escape($Value)
}

function Inline-Runs([string]$Text) {
  $segments = [regex]::Split($Text, '(\*\*[^*]+\*\*)')
  $xml = New-Object System.Text.StringBuilder
  foreach ($segment in $segments) {
    if ([string]::IsNullOrEmpty($segment)) { continue }
    $bold = $segment.StartsWith('**') -and $segment.EndsWith('**')
    $value = if ($bold) { $segment.Substring(2, $segment.Length - 4) } else { $segment }
    $properties = if ($bold) { '<w:rPr><w:b/><w:bCs/></w:rPr>' } else { '' }
    [void]$xml.Append("<w:r>$properties<w:t xml:space=`"preserve`">$(Escape-Xml $value)</w:t></w:r>")
  }
  return $xml.ToString()
}

function Paragraph([string]$Text, [string]$Style = 'Normal', [int]$Before = 0, [int]$After = 100) {
  $styleXml = if ($Style) { "<w:pStyle w:val=`"$Style`"/>" } else { '' }
  return "<w:p><w:pPr>$styleXml<w:spacing w:before=`"$Before`" w:after=`"$After`"/></w:pPr>$(Inline-Runs $Text)</w:p>"
}

function List-Paragraph([string]$Text, [string]$Marker = '• ') {
  $marker = $Marker
  return "<w:p><w:pPr><w:spacing w:after=`"60`"/><w:ind w:left=`"420`" w:hanging=`"240`"/></w:pPr>$(Inline-Runs ($marker + $Text))</w:p>"
}

function Table-Xml([System.Collections.Generic.List[object]]$Rows) {
  if ($Rows.Count -lt 2) { return '' }
  $dataRows = @($Rows[0]) + @($Rows | Select-Object -Skip 2)
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('<w:tbl><w:tblPr><w:tblStyle w:val="TableNormal"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D7DCE2"/><w:left w:val="single" w:sz="4" w:color="D7DCE2"/><w:bottom w:val="single" w:sz="4" w:color="D7DCE2"/><w:right w:val="single" w:sz="4" w:color="D7DCE2"/><w:insideH w:val="single" w:sz="4" w:color="D7DCE2"/><w:insideV w:val="single" w:sz="4" w:color="D7DCE2"/></w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr>')
  for ($rowIndex = 0; $rowIndex -lt $dataRows.Count; $rowIndex++) {
    [void]$builder.Append('<w:tr>')
    foreach ($cell in $dataRows[$rowIndex]) {
      $shade = if ($rowIndex -eq 0) { '<w:shd w:val="clear" w:fill="F3E7D3"/>' } else { '' }
      $runs = Inline-Runs $cell.Trim()
      if ($rowIndex -eq 0) { $runs = "<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t xml:space=`"preserve`">$(Escape-Xml $cell.Trim())</w:t></w:r>" }
      [void]$builder.Append("<w:tc><w:tcPr><w:tcW w:w=`"0`" w:type=`"auto`"/>$shade</w:tcPr><w:p><w:pPr><w:spacing w:after=`"0`"/></w:pPr>$runs</w:p></w:tc>")
    }
    [void]$builder.Append('</w:tr>')
  }
  [void]$builder.Append('</w:tbl><w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>')
  return $builder.ToString()
}

if (-not (Test-Path -LiteralPath $TemplatePath)) { throw "Template not found: $TemplatePath" }
if (-not (Test-Path -LiteralPath $MarkdownPath)) { throw "Markdown source not found: $MarkdownPath" }

$lines = Get-Content -LiteralPath $MarkdownPath -Encoding UTF8
$body = New-Object System.Text.StringBuilder
$paragraphBuffer = New-Object System.Collections.Generic.List[string]

function Flush-Paragraph {
  if ($paragraphBuffer.Count -gt 0) {
    [void]$body.Append((Paragraph (($paragraphBuffer -join ' ').Trim())))
    $paragraphBuffer.Clear()
  }
}

$index = 0
while ($index -lt $lines.Count) {
  $line = $lines[$index].TrimEnd()
  if ([string]::IsNullOrWhiteSpace($line)) { Flush-Paragraph; $index++; continue }
  if ($line -eq '---') { Flush-Paragraph; [void]$body.Append('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8" w:color="D79B3B"/></w:pBdr><w:spacing w:before="100" w:after="180"/></w:pPr></w:p>'); $index++; continue }
  if ($line -match '^\|') {
    Flush-Paragraph
    $rows = New-Object System.Collections.Generic.List[object]
    while ($index -lt $lines.Count -and $lines[$index].Trim() -match '^\|') {
      $cells = @($lines[$index].Trim().Trim('|').Split('|') | ForEach-Object { $_.Trim() })
      $rows.Add($cells)
      $index++
    }
    [void]$body.Append((Table-Xml $rows))
    continue
  }
  if ($line -match '^# (.+)$') { Flush-Paragraph; [void]$body.Append((Paragraph $Matches[1] 'Title' 0 80)); $index++; continue }
  if ($line -match '^## (.+)$') { Flush-Paragraph; [void]$body.Append((Paragraph $Matches[1] 'Heading1' 220 100)); $index++; continue }
  if ($line -match '^### (.+)$') { Flush-Paragraph; [void]$body.Append((Paragraph $Matches[1] 'Heading2' 160 80)); $index++; continue }
  if ($line -match '^(\d+)\. (.+)$') { Flush-Paragraph; [void]$body.Append((List-Paragraph $Matches[2] ($Matches[1] + '. '))); $index++; continue }
  if ($line -match '^- (.+)$') { Flush-Paragraph; [void]$body.Append((List-Paragraph $Matches[1] '• ')); $index++; continue }
  $paragraphBuffer.Add($line.Trim())
  $index++
}
Flush-Paragraph

$section = '<w:sectPr><w:headerReference r:id="rId6" w:type="default"/><w:footerReference r:id="rId7" w:type="default"/><w:pgSz w:h="15840" w:w="12240" w:orient="portrait"/><w:pgMar w:bottom="1080" w:top="1080" w:left="1080" w:right="1080" w:header="540" w:footer="540"/><w:pgNumType w:start="1"/></w:sectPr>'
$documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' + $body.ToString() + $section + '</w:body></w:document>'

$outputDirectory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory | Out-Null }
$temporaryPath = Join-Path ([System.IO.Path]::GetTempPath()) ("tlt-playbook-" + [guid]::NewGuid().ToString('N') + '.docx')
[System.IO.File]::Copy($TemplatePath, $temporaryPath, $true)
$archive = [System.IO.Compression.ZipFile]::Open($temporaryPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
  $existing = $archive.GetEntry('word/document.xml')
  if ($existing) { $existing.Delete() }
  $entry = $archive.CreateEntry('word/document.xml', [System.IO.Compression.CompressionLevel]::Optimal)
  $stream = $entry.Open()
  $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
  $writer.Write($documentXml)
  $writer.Dispose()
} finally {
  $archive.Dispose()
}
[System.IO.File]::Copy($temporaryPath, $OutputPath, $true)
Remove-Item -LiteralPath $temporaryPath -Force
Write-Output "Created $OutputPath"
