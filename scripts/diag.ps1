# One coherent look at the island window: its extended styles, and whether
# clicking it takes the keyboard. Development aid only.
#
# Uses GetWindowLongPtrW explicitly — the unsuffixed name is a macro in the SDK
# and is not necessarily a real export, so binding to it gives nonsense.

# CharSet.Unicode matters: these are the wide-char entry points, and without it
# the marshaller reads the string back as ANSI and every title comes out blank.
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class D {
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
  public static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
}
'@

function Title($h) {
  $sb = New-Object System.Text.StringBuilder 300
  [void][D]::GetWindowText($h, $sb, 300)
  $sb.ToString()
}

# Find the island window (the one titled exactly "Ryfe"). A hashtable rather
# than a scoped variable: the delegate runs outside this scope, so an assignment
# to $script: inside it would not come back.
$box = @{ island = [IntPtr]::Zero; all = @() }
$cb = [D+EnumWindowsProc]{
  param($h, $l)
  # Everything inlined: calling a PowerShell function from inside the delegate
  # does not work reliably, and silently yields empty titles.
  $sb = New-Object System.Text.StringBuilder 300
  [void][D]::GetWindowText($h, $sb, 300)
  $t = $sb.ToString()
  if ($t -like '*Ryfe*') { $box.all += "$t ($h)" }
  if ($t -eq 'Ryfe') { $box.island = $h }
  return $true
}
[void][D]::EnumWindows($cb, [IntPtr]::Zero)

$island = $box.island
if ($island -eq [IntPtr]::Zero) {
  Write-Output "island window not found. Windows mentioning Ryfe:"
  $box.all | ForEach-Object { Write-Output "  $_" }
  exit 1
}

$r = New-Object D+RECT
[void][D]::GetWindowRect($island, [ref]$r)

Write-Output "island hwnd   : $island"
Write-Output "island rect   : $($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)"

function Report-Style($when) {
  $ex = [D]::GetWindowLongPtrW($island, -20).ToInt64()
  $noact = ($ex -band 0x08000000) -ne 0
  $tool  = ($ex -band 0x00000080) -ne 0
  $trans = ($ex -band 0x00000020) -ne 0
  Write-Output ("  {0,-9} exstyle=0x{1:X9}  NOACTIVATE={2,-5} TOOLWINDOW={3,-5} TRANSPARENT={4}" -f $when, $ex, $noact, $tool, $trans)
}

Write-Output ""
Report-Style "at start"

# Wake the island, then click it.
$cx = [int](($r.L + $r.R) / 2)
[void][D]::SetCursorPos($cx, 2); Start-Sleep -Milliseconds 1500
[void][D]::SetCursorPos($cx, 34); Start-Sleep -Milliseconds 1500

Report-Style "before"
$before = Title ([D]::GetForegroundWindow())

[D]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[D]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800

$after = Title ([D]::GetForegroundWindow())
Report-Style "after"

Write-Output ""
Write-Output "foreground before click : $before"
Write-Output "foreground after click  : $after"
if ($after -ne 'Ryfe') { Write-Output "PASS - the island did not take the keyboard" }
else { Write-Output "FAIL - the island took the keyboard" }
