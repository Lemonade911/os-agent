param()

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $root ".env"
$logPath = Join-Path $root "setup-gui.log"
$script:LogBuffer = New-Object System.Collections.Generic.List[string]

# UTF-8 Base64 -> string (keeps this .ps1 ASCII-only and encoding-safe)
function T([string]$b64, [object[]]$args) {
  $s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
  if ($null -ne $args -and $args.Count -gt 0) { return ($s -f $args) }
  return $s
}

$TXT = @{
  Title = "6aG555uu5ZCv5Yqo5ZmoIC0gRnVzaW9uT1MgQWdlbnQ="
  KeyLabel = "5qih5Z6LIEtlee+8iExMTV9BUElfS0VZ77yJ"
  KeyCue = "5L6L5aaC77yac2steHh4eA=="
  BaseLabel = "5qih5Z6L5Zyw5Z2A77yITExNX0JBU0VfVVJM77yJ"
  BaseCue = "5L6L5aaC77yaaHR0cHM6Ly9hcGkuZGVlcHNlZWsuY29tL3Yx"
  ModelLabel = "5qih5Z6L5ZCN56ew77yITExNX01PREVM77yJ"
  ModelCue = "5L6L5aaC77yaZGVlcHNlZWstY2hhdA=="
  SshHeader = "U1NIIOi/nOeoi+i/nuaOpe+8iOeUqOS6juaJp+ihjOWRveS7pO+8iQ=="
  SshHostLabel = "TGludXggSVDvvIhTU0hfSE9TVO+8iQ=="
  SshHostCue = "5L6L5aaC77yaMTkyLjE2OC4xLjEw"
  SshPortLabel = "U1NIIOerr+WPo++8iFNTSF9QT1JU77yJ"
  SshPortCue = "5LiA6Iis5pivIDIy"
  SshUserLabel = "55So5oi35ZCN77yIU1NIX1VTRVJOQU1F77yJ"
  SshUserCue = "5L6L5aaC77yacm9vdA=="
  SshPassLabel = "5a+G56CB77yIU1NIX1BBU1NXT1JE77yJ"
  SshPassCue = "55WZ56m6PeS4jeS/ruaUuQ=="
  FrontHeader = "5YmN56uv6K6/6Zeu5ZCO56uv77yI5ZCM5q2l5YiwIEhUTUwg55qEIEFQSV9VUkzvvIk="
  ApiHostLabel = "5ZCO56uv5Zyw5Z2A77yIQVBJX0hPU1TvvIk="
  ApiHostCue = "5pys5py6PTEyNy4wLjAuMe+8m+WxgOWfn+e9kT3mnKzmnLpJUA=="
  AgentPortLabel = "56uv5Y+j77yIQUdFTlRfUE9SVO+8iQ=="
  AgentPortCue = "5Lya5ZCM5pe25YaZ5YWlIC5lbnYg5LiOIEhUTUw="
  AgentPortTip = "6K+05piO77ya5Lya5YaZ5YWlIC5lbnYg55qEIE9TX0FHRU5UX1BPUlTvvIzlubblkIzmraXmm7TmlrAgSFRNTCDnmoQgQVBJX1VSTCDnq6/lj6M="
  HtmlFileLabel = "5YmN56uv5paH5Lu277yISFRNTF9GSUxF77yJ"
  Ready = "5bCx57uq77ya6K+35aGr5YaZ6YWN572u5ZCO54K55Ye74oCc5LuF5L+d5a2Y4oCd5oiW4oCc5LiA6ZSu5ZCv5Yqo4oCd44CC"
  WriteEnv = "5YaZ5YWlIC5lbnbvvJp7MH0="
  WriteHtml = "5YaZ5YWlIEhUTUzvvJp7MH0="
  PortMustNumber = "56uv5Y+j5b+F6aG75piv5pWw5a2X77yI5L6L5aaCIDMwMDHvvInjgII="
  ChooseHtml = "6K+36YCJ5oup5LiA5Liq5pyJ5pWI55qEIEhUTUxfRklMRe+8iOS4i+aLieahhumHjOmAie+8ieOAgg=="
  Saved = "5L+d5a2Y5oiQ5Yqf77ya5bey5ZCM5q2l5YiwIC5lbnYgKyBIVE1M44CCQVBJX1VSTCA9PiB7MH0="
  BtnSaveOnly = "5L+d5oyB"
  BtnStart = "5L+d5oyB5bm25ZCv5Yqo"
  Preparing = "5bey5L+d5a2Y77yM5q2j5Zyo5YeG5aSH5ZCv5Yqo56qX5Y+jLi4u"
  Runner1 = "WzEvMl0g5a6J6KOF5L6d6LWW5LitLi4u"
  Runner2 = "WzIvMl0g5ZCv5Yqo5pyN5Yqh5LitLi4u"
  ErrTitle = "6ZSZ6K+v"
  FatalTitle = "5ZCv5Yqo5Zmo6ZSZ6K+v"
}

function Log([string]$msg) {
  try { [void]$script:LogBuffer.Add(("[{0}] {1}" -f ([DateTime]::Now.ToString("s")), $msg)) } catch {}
}

function Flush-Log() {
  try {
    if ($script:LogBuffer.Count -le 0) { return }
    $script:LogBuffer | Out-File -LiteralPath $logPath -Encoding UTF8 -Force
    try { attrib +h $logPath } catch {}
  } catch {}
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32CueBanner {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern Int32 SendMessage(IntPtr hWnd, int msg, int wParam, string lParam);
  public const int EM_SETCUEBANNER = 0x1501;
}
"@

function Set-Cue([System.Windows.Forms.TextBox]$tb, [string]$text) {
  try { [void][Win32CueBanner]::SendMessage($tb.Handle, [Win32CueBanner]::EM_SETCUEBANNER, 0, $text) } catch {}
}

function Get-EnvMap([string]$path) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $path)) { return $map }
  $needsUnescape = @("SSH_PASSWORD","SSH_PRIVATE_KEY")
  Get-Content -LiteralPath $path -Encoding UTF8 | ForEach-Object {
    $line = $_
    if ($line -match "^\s*#") { return }
    if ($line -match "^\s*$") { return }
    if ($line -match "^\s*([^=\s]+)\s*=\s*(.*)\s*$") {
      $k = $Matches[1]
      $v = ($Matches[2]).Trim()
      if (-not ($v.StartsWith('"') -or $v.StartsWith("'"))) {
        $hash = $v.IndexOf(" #")
        if ($hash -ge 0) { $v = $v.Substring(0, $hash).Trim() }
      }
      if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      if ($needsUnescape -contains $k) {
        $v = $v -replace '\\\\', '\'
        $v = $v -replace '\\"', '"'
      }
      $map[$k] = $v
    }
  }
  return $map
}

function Quote-EnvValue([string]$name, [string]$value) {
  if ($name -eq "SSH_PASSWORD" -or $name -eq "SSH_PRIVATE_KEY") {
    $v = $value
    if ($null -eq $v) { $v = "" }
    $v = $v -replace '"','\"'
    return '"' + $v + '"'
  }
  return $value
}

function Ensure-EnvVar([string]$path, [string]$name, [string]$value) {
  $lines = @()
  if (Test-Path -LiteralPath $path) { $lines = Get-Content -LiteralPath $path -Encoding UTF8 }

  $stripCommentNames = @(
    "LLM_API_KEY","LLM_BASE_URL","LLM_MODEL",
    "SSH_HOST","SSH_PORT","SSH_USERNAME","SSH_PASSWORD","SSH_PRIVATE_KEY",
    "OS_AGENT_PORT"
  )
  $stripComment = $stripCommentNames -contains $name

  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match ("^\s*" + [regex]::Escape($name) + "\s*=")) {
      $found = $true
      if ($stripComment) {
        $lines[$i] = ($name + "=" + (Quote-EnvValue $name $value))
      } else {
        if ($line -match ("^(?<pre>\s*" + [regex]::Escape($name) + "\s*=\s*)(?<val>.*?)(?<c>\s+#.*)?$")) {
          $comment = $Matches["c"]; if ($null -eq $comment) { $comment = "" }
          $lines[$i] = $Matches["pre"] + (Quote-EnvValue $name $value) + $comment
        } else {
          $lines[$i] = ($name + "=" + (Quote-EnvValue $name $value))
        }
      }
      break
    }
  }
  if (-not $found) { $lines += ($name + "=" + (Quote-EnvValue $name $value)) }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines((Resolve-Path -LiteralPath $path), $lines, $utf8NoBom)
}

function Update-FusionAgentHtmlApiUrl([string]$path, [string]$apiUrl) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $lines = Get-Content -LiteralPath $path -Encoding UTF8
  $updated = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*const\s+API_URL\s*=") {
      $indent = ""; if ($lines[$i] -match "^(\s*)") { $indent = $Matches[1] }
      $lines[$i] = ($indent + ("const API_URL = ""{0}"";" -f $apiUrl))
      $updated = $true
      break
    }
  }
  if (-not $updated) { throw "Cannot find const API_URL in fusion-agent.html" }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines((Resolve-Path -LiteralPath $path), $lines, $utf8NoBom)
}

function Read-ApiHostPortFromHtml([string]$path) {
  $result = @{ Host = $null; Port = $null }
  if (-not (Test-Path -LiteralPath $path)) { return $result }
  $content = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  $m = [regex]::Match($content, "const\s+API_URL\s*=\s*['""](?<url>[^'""]+)['""]\s*;")
  if (-not $m.Success) { return $result }
  try {
    $uri = [System.Uri]::new($m.Groups["url"].Value)
    $result.Host = $uri.Host
    $result.Port = $uri.Port.ToString()
  } catch {}
  return $result
}

function Resolve-HtmlPath([string]$rootDir, [string]$inputPath) {
  $candidate = $inputPath
  if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = "fusion-agent.html" }
  if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $rootDir $candidate }
  if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate) }
  $fallback = Get-ChildItem -LiteralPath $rootDir -Filter "*.html" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $fallback) { return $fallback.FullName }
  throw ("HTML file not found. Input='{0}' root='{1}'" -f $inputPath, $rootDir)
}

function Get-HtmlCandidates([string]$rootDir) {
  $items = New-Object System.Collections.Generic.List[string]
  $htmls = Get-ChildItem -LiteralPath $rootDir -Filter "*.html" -File -ErrorAction SilentlyContinue
  foreach ($f in $htmls) { $items.Add($f.Name) }
  if ($items.Count -eq 0) { $items.Add("fusion-agent.html") }
  return $items
}

function Run-CmdInNewWindow([string]$workingDir, [string]$cmdLine) {
  Start-Process -FilePath "cmd.exe" -WorkingDirectory $workingDir -ArgumentList "/k", $cmdLine
}

try {
  try { if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue } } catch {}
  Log "starting"
  try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch {}

  $current = Get-EnvMap $envPath
  $defaultHtmlName = "fusion-agent.html"

  $form = New-Object System.Windows.Forms.Form
  $form.Text = (T $TXT.Title)
  $form.Size = New-Object System.Drawing.Size(860, 700)
  $form.MinimumSize = New-Object System.Drawing.Size(860, 700)
  $form.MaximumSize = New-Object System.Drawing.Size(860, 700)
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
  $form.MaximizeBox = $false
  $form.AutoScroll = $false
  $form.StartPosition = "CenterScreen"
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

  $rootLayout = New-Object System.Windows.Forms.TableLayoutPanel
  $rootLayout.Dock = "Top"
  $rootLayout.AutoSize = $true
  $rootLayout.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
  $rootLayout.Padding = New-Object System.Windows.Forms.Padding(14, 12, 14, 12)
  $rootLayout.RowCount = 6
  $rootLayout.ColumnCount = 1
  $rootLayout.GrowStyle = [System.Windows.Forms.TableLayoutPanelGrowStyle]::AddRows
  $form.Controls.Add($rootLayout)

  function New-Group([string]$title) {
    $gb = New-Object System.Windows.Forms.GroupBox
    $gb.Text = $title
    $gb.Dock = "Top"
    $gb.AutoSize = $true
    $gb.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $gb.Padding = New-Object System.Windows.Forms.Padding(10, 18, 10, 10)

    $tbl = New-Object System.Windows.Forms.TableLayoutPanel
    $tbl.Dock = "Top"
    $tbl.AutoSize = $true
    $tbl.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
    $tbl.ColumnCount = 2
    $tbl.RowCount = 0
    $tbl.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 220))) | Out-Null
    $tbl.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null

    $gb.Controls.Add($tbl)
    return @{ Box = $gb; Table = $tbl }
  }

  function Add-Row($tbl, [string]$labelText, [System.Windows.Forms.Control]$control) {
    $row = $tbl.RowCount
    $tbl.RowCount = $tbl.RowCount + 1
    $tbl.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $labelText
    $lbl.AutoSize = $true
    $lbl.Anchor = "Left"

    $control.Anchor = "Left,Right"
    $control.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 4)

    $tbl.Controls.Add($lbl, 0, $row)
    $tbl.Controls.Add($control, 1, $row)
  }

  function Add-FullRow($tbl, [System.Windows.Forms.Control]$control) {
    $row = $tbl.RowCount
    $tbl.RowCount = $tbl.RowCount + 1
    $tbl.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::AutoSize))) | Out-Null
    $control.Anchor = "Left,Right"
    $control.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 2)
    $tbl.Controls.Add($control, 0, $row)
    $tbl.SetColumnSpan($control, 2)
  }

  # LLM group
  $gLlm = New-Group "LLM"
  $tbKey = New-Object System.Windows.Forms.TextBox
  $tbKey.Text = $current["LLM_API_KEY"]
  Set-Cue $tbKey (T $TXT.KeyCue)
  Add-Row $gLlm.Table (T $TXT.KeyLabel) $tbKey

  $tbBase = New-Object System.Windows.Forms.TextBox
  $tbBase.Text = $current["LLM_BASE_URL"]
  Set-Cue $tbBase (T $TXT.BaseCue)
  Add-Row $gLlm.Table (T $TXT.BaseLabel) $tbBase

  $tbModel = New-Object System.Windows.Forms.TextBox
  $tbModel.Text = $current["LLM_MODEL"]
  Set-Cue $tbModel (T $TXT.ModelCue)
  Add-Row $gLlm.Table (T $TXT.ModelLabel) $tbModel

  # SSH group
  $gSsh = New-Group (T $TXT.SshHeader)
  $tbSshHost = New-Object System.Windows.Forms.TextBox
  $tbSshHost.Text = $current["SSH_HOST"]
  Set-Cue $tbSshHost (T $TXT.SshHostCue)
  Add-Row $gSsh.Table (T $TXT.SshHostLabel) $tbSshHost

  $tbSshPort = New-Object System.Windows.Forms.TextBox
  $tbSshPort.Text = $current["SSH_PORT"]
  Set-Cue $tbSshPort (T $TXT.SshPortCue)
  Add-Row $gSsh.Table (T $TXT.SshPortLabel) $tbSshPort

  $tbSshUser = New-Object System.Windows.Forms.TextBox
  $tbSshUser.Text = $current["SSH_USERNAME"]
  Set-Cue $tbSshUser (T $TXT.SshUserCue)
  Add-Row $gSsh.Table (T $TXT.SshUserLabel) $tbSshUser

  $tbSshPass = New-Object System.Windows.Forms.TextBox
  $tbSshPass.UseSystemPasswordChar = $true
  $tbSshPass.Text = $current["SSH_PASSWORD"]
  Set-Cue $tbSshPass (T $TXT.SshPassCue)
  Add-Row $gSsh.Table (T $TXT.SshPassLabel) $tbSshPass

  # Frontend group
  $gFront = New-Group (T $TXT.FrontHeader)
  $tbApiHost = New-Object System.Windows.Forms.TextBox
  $tbApiHost.Text = "127.0.0.1"
  Set-Cue $tbApiHost (T $TXT.ApiHostCue)
  Add-Row $gFront.Table (T $TXT.ApiHostLabel) $tbApiHost

  $tbPort = New-Object System.Windows.Forms.TextBox
  $tbPort.Text = $(if ($current.ContainsKey("OS_AGENT_PORT")) { $current["OS_AGENT_PORT"] } else { "3001" })
  Set-Cue $tbPort (T $TXT.AgentPortCue)
  $tbPort.Add_KeyPress({
    param($sender, $e)
    if (-not [char]::IsControl($e.KeyChar) -and -not [char]::IsDigit($e.KeyChar)) { $e.Handled = $true }
  })
  Add-Row $gFront.Table (T $TXT.AgentPortLabel) $tbPort

  $lblPortTip = New-Object System.Windows.Forms.Label
  $lblPortTip.Text = (T $TXT.AgentPortTip)
  $lblPortTip.AutoSize = $true
  $lblPortTip.ForeColor = [System.Drawing.Color]::DimGray
  Add-FullRow $gFront.Table $lblPortTip

  $cbHtml = New-Object System.Windows.Forms.ComboBox
  $cbHtml.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  $htmlCandidates = Get-HtmlCandidates $root
  foreach ($item in $htmlCandidates) { [void]$cbHtml.Items.Add($item) }
  if ($cbHtml.Items.Count -gt 0) { $cbHtml.SelectedIndex = 0 }
  if ($cbHtml.Items.Contains($defaultHtmlName)) { $cbHtml.SelectedItem = $defaultHtmlName }
  Add-Row $gFront.Table (T $TXT.HtmlFileLabel) $cbHtml

  # Status + paths
  $lblStatus = New-Object System.Windows.Forms.Label
  $lblStatus.Text = (T $TXT.Ready)
  $lblStatus.AutoSize = $true

  $lblPath = New-Object System.Windows.Forms.Label
  $lblPath.Text = ((T "5YaZ5YWlIC5lbnbvvJo=") + $envPath)
  $lblPath.AutoSize = $true
  $lblPath.ForeColor = [System.Drawing.Color]::DimGray

  $lblPathHtml = New-Object System.Windows.Forms.Label
  $lblPathHtml.Text = ((T "5YaZ5YWlIEhUTUzvvJo=") + (Join-Path $root $defaultHtmlName))
  $lblPathHtml.AutoSize = $true
  $lblPathHtml.ForeColor = [System.Drawing.Color]::DimGray

  $statusPanel = New-Object System.Windows.Forms.Panel
  $statusPanel.Dock = "Top"
  $statusPanel.AutoSize = $true
  $statusPanel.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
  $statusPanel.Padding = New-Object System.Windows.Forms.Padding(2, 6, 2, 0)
  $statusPanel.Controls.Add($lblStatus)
  $statusPanel.Controls.Add($lblPath)
  $statusPanel.Controls.Add($lblPathHtml)
  $lblStatus.Location = New-Object System.Drawing.Point(0, 0)
  $lblPath.Location = New-Object System.Drawing.Point(0, 24)
  $lblPathHtml.Location = New-Object System.Drawing.Point(0, 46)

  # Buttons
  $btnPanel = New-Object System.Windows.Forms.FlowLayoutPanel
  $btnPanel.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
  $btnPanel.Dock = "Fill"
  $btnPanel.AutoSize = $false
  $btnPanel.WrapContents = $false
  $btnPanel.Padding = New-Object System.Windows.Forms.Padding(8, 2, 0, 0)
  $btnPanel.Margin = New-Object System.Windows.Forms.Padding(0)

  $btnOk = New-Object System.Windows.Forms.Button
  $btnOk.Text = (T $TXT.BtnSaveOnly)
  $btnOk.AutoSize = $false
  $btnOk.Size = New-Object System.Drawing.Size(230, 36)

  $btnAll = New-Object System.Windows.Forms.Button
  $btnAll.Text = (T $TXT.BtnStart)
  $btnAll.AutoSize = $false
  $btnAll.Size = New-Object System.Drawing.Size(230, 36)
  $btnAll.BackColor = [System.Drawing.Color]::FromArgb(48, 120, 210)
  $btnAll.ForeColor = [System.Drawing.Color]::White

  $btnPanel.Controls.Add($btnOk)
  $btnPanel.Controls.Add($btnAll)

  # Status + actions in one row: status left, buttons right
  $statusActionRow = New-Object System.Windows.Forms.TableLayoutPanel
  $statusActionRow.Dock = "Top"
  $statusActionRow.AutoSize = $false
  $statusActionRow.Height = 96
  $statusActionRow.ColumnCount = 2
  $statusActionRow.RowCount = 1
  $statusActionRow.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 0)
  $statusActionRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $statusActionRow.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 260))) | Out-Null
  $statusActionRow.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $statusActionRow.Controls.Add($statusPanel, 0, 0)
  $statusActionRow.Controls.Add($btnPanel, 1, 0)

  # Add to root layout
  $rootLayout.Controls.Add($gLlm.Box)
  $rootLayout.Controls.Add($gSsh.Box)
  $rootLayout.Controls.Add($gFront.Box)
  $rootLayout.Controls.Add($statusActionRow)

  $updateApiDefaultsFromHtml = {
    if ($cbHtml.SelectedItem -eq $null) { return }
    $resolved = Resolve-HtmlPath $root $cbHtml.SelectedItem.ToString()
    $api = Read-ApiHostPortFromHtml $resolved
    if (-not [string]::IsNullOrWhiteSpace($api["Host"])) { $tbApiHost.Text = $api["Host"] }
    if (-not [string]::IsNullOrWhiteSpace($api["Port"])) { $tbPort.Text = $api["Port"] }
    $lblPathHtml.Text = ((T "5YaZ5YWlIEhUTUzvvJo=") + $resolved)
  }
  $cbHtml.Add_SelectedIndexChanged($updateApiDefaultsFromHtml)
  & $updateApiDefaultsFromHtml

  function Save-Config {
    $agentPort = $tbPort.Text.Trim()
    if ($agentPort.Length -eq 0) { $agentPort = "3001" }
    if ($agentPort -notmatch '^\d+$') { throw (T $TXT.PortMustNumber) }
    $apiHost = $tbApiHost.Text.Trim()
    if ($apiHost.Length -eq 0) { $apiHost = "127.0.0.1" }
    if ($cbHtml.SelectedItem -eq $null -or [string]::IsNullOrWhiteSpace($cbHtml.SelectedItem.ToString())) {
      throw (T $TXT.ChooseHtml)
    }

    $apiUrl = ("http://{0}:{1}/v1/chat/completions" -f $apiHost, $agentPort)
    $resolvedHtmlPath = Resolve-HtmlPath $root $cbHtml.SelectedItem.ToString()

    Ensure-EnvVar $envPath "LLM_API_KEY" $tbKey.Text
    Ensure-EnvVar $envPath "LLM_BASE_URL" $tbBase.Text
    Ensure-EnvVar $envPath "LLM_MODEL" $tbModel.Text

    Ensure-EnvVar $envPath "SSH_HOST" $tbSshHost.Text
    Ensure-EnvVar $envPath "SSH_PORT" $tbSshPort.Text
    Ensure-EnvVar $envPath "SSH_USERNAME" $tbSshUser.Text
    if ($tbSshPass.Text.Trim().Length -gt 0) {
      Ensure-EnvVar $envPath "SSH_PASSWORD" $tbSshPass.Text
    }

    Ensure-EnvVar $envPath "OS_AGENT_PORT" $agentPort
    Update-FusionAgentHtmlApiUrl $resolvedHtmlPath $apiUrl

    $after = Get-EnvMap $envPath
    $expected = @{
      "LLM_API_KEY"   = $tbKey.Text
      "LLM_BASE_URL"  = $tbBase.Text
      "LLM_MODEL"     = $tbModel.Text
      "SSH_HOST"      = $tbSshHost.Text
      "SSH_PORT"      = $tbSshPort.Text
      "SSH_USERNAME"  = $tbSshUser.Text
      "OS_AGENT_PORT" = $agentPort
    }
    foreach ($k in $expected.Keys) {
      $ev = $expected[$k]
      $av = $after[$k]
      if ($null -eq $av) { throw ("Save failed: {0} not found in {1}" -f $k, $envPath) }
      if (($av + "") -ne ($ev + "")) { throw ("Save mismatch: {0}" -f $k) }
    }

    $lblPath.Text = ((T "5YaZ5YWlIC5lbnbvvJo=") + $envPath)
    $lblPathHtml.Text = ((T "5YaZ5YWlIEhUTUzvvJo=") + $resolvedHtmlPath)
    $lblStatus.Text = ((T "5L+d5a2Y5oiQ5Yqf77ya5bey5ZCM5q2l5YiwIC5lbnYgKyBIVE1M44CCQVBJX1VSTCA9PiA=") + $apiUrl)
    Log ("saved apiUrl={0}" -f $apiUrl)
  }

  # Hook button events (buttons are created in the layout above)
  $btnOk.Add_Click({
    try { Save-Config; $form.Close() }
    catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (T $TXT.ErrTitle)) | Out-Null }
  })

  $btnAll.Add_Click({
    try {
      Save-Config
      $lblStatus.Text = (T $TXT.Preparing)
      $r1 = (T $TXT.Runner1)
      $r2 = (T $TXT.Runner2)
      Run-CmdInNewWindow $root ("title FusionOS Agent Dev Runner && timeout /t 3 /nobreak >nul && echo {0} && corepack pnpm install --config.confirmModulesPurge=false --reporter=silent && echo {1} && corepack pnpm run dev" -f $r1, $r2)
      $form.Close()
    }
    catch { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (T $TXT.ErrTitle)) | Out-Null }
  })

  [void]$form.ShowDialog()
  Log "closed"
}
catch {
  Log ("ERROR: {0}" -f $_.Exception.Message)
  try {
    Log ("ERROR_LINE: {0}" -f $_.InvocationInfo.ScriptLineNumber)
    Log ("ERROR_TEXT: {0}" -f $_.InvocationInfo.Line)
  } catch {}
  Flush-Log
  try { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (T $TXT.FatalTitle)) | Out-Null } catch {}
  exit 1
}

