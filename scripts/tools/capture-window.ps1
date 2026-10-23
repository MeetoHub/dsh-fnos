# 截取 DSH 桌面窗口
#
# 用途：给 README / Release 准备真实界面截图。
# 原理：Win32 PrintWindow + PW_RENDERFULLCONTENT，能截到 Electron/Chromium 的真实渲染内容
#       （普通 BitBlt 对硬件加速窗口只会得到黑图）。
#
# 为什么必须用 Windows PowerShell 5.1：
#   PowerShell 7 走 .NET Core，默认不带 System.Drawing.Common；
#   5.1 是完整 .NET Framework，System.Drawing 开箱可用。
#
# 用法：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/tools/capture-window.ps1
#   powershell.exe ... -File scripts/tools/capture-window.ps1 -Out docs/images/picker.png
#   powershell.exe ... -File scripts/tools/capture-window.ps1 -ProcessName "DeepSeek Harness"
#
param(
    [string]$Out = "docs/images/screenshot.png",
    [string]$ProcessName = "DeepSeek Harness",
    [int]$DelayMs = 0
)

Add-Type -AssemblyName System.Drawing

$src = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class DshWindowCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string Capture(long hwnd, string path) {
    IntPtr h = new IntPtr(hwnd);
    RECT r;
    if (!GetWindowRect(h, out r)) return "GetWindowRect failed";
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return "bad window size";
    using (var bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(h, hdc, 2);   // 2 = PW_RENDERFULLCONTENT
      g.ReleaseHdc(hdc);
      if (!ok) return "PrintWindow returned false";
      bmp.Save(path, ImageFormat.Png);
      return "ok " + w + "x" + ht;
    }
  }
}
"@

Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing

if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1

if (-not $proc) {
    Write-Output "no-window: 未找到带窗口的进程 '$ProcessName'"
    exit 1
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

Write-Output ("pid=" + $proc.Id + "  title=" + $proc.MainWindowTitle)
Write-Output ([DshWindowCapture]::Capture([int64]$proc.MainWindowHandle, (Resolve-Path -LiteralPath $dir).Path + "\" + (Split-Path -Leaf $Out)))
