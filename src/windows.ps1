param([ValidateSet('monitor','activate','place','resolve')][string]$Action, [string]$Target, [int]$X, [int]$Y, [int]$Width, [int]$Height)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Action -eq 'resolve') {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Target)
    [Console]::WriteLine($link.TargetPath)
    exit
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
    public delegate bool Callback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback fn, IntPtr data);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int d, uint f);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder b, int max);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder text, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static string Image(IntPtr hwnd) {
        uint id; GetWindowThreadProcessId(hwnd, out id);
        IntPtr p = OpenProcess(0x1000, false, id);
        if (p == IntPtr.Zero) return "";
        try {
            var text = new StringBuilder(4096); int size=text.Capacity;
            return QueryFullProcessImageName(p,0,text,ref size) ? text.ToString() : "";
        } finally { CloseHandle(p); }
    }
    public static IntPtr Find(string target) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            if (IsWindowVisible(hwnd) && GetWindow(hwnd,4)==IntPtr.Zero &&
                String.Equals(Image(hwnd), target, StringComparison.OrdinalIgnoreCase)) {
                result=hwnd; return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
[void][Native]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($Action -eq 'monitor') {
    while ($true) {
        $h = [Native]::GetForegroundWindow()
        $rect = [Native+Rect]::new()
        $class = [Text.StringBuilder]::new(256)
        [void][Native]::GetClassName($h, $class, 256)
        $skip = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd') -contains $class.ToString()
        if (!$skip -and [Native]::GetWindowRect($h,[ref]$rect)) {
            [Console]::WriteLine(('{0} {1} {2} {3}' -f $rect.Left,$rect.Top,$rect.Right,$rect.Bottom))
        } else { [Console]::WriteLine('none') }
        Start-Sleep -Milliseconds 360
    }
}
$h = [Native]::Find($Target)
if ($Action -eq 'place') {
    for ($i=0; $h -eq [IntPtr]::Zero -and $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 200
        $h = [Native]::Find($Target)
    }
}
if ($h -eq [IntPtr]::Zero) { exit 2 }
if ([Native]::IsIconic($h) -or ($Action -eq 'place' -and [Native]::IsZoomed($h))) {
    [void][Native]::ShowWindowAsync($h, 9)
    Start-Sleep -Milliseconds 140
}
if ($Action -eq 'place') {
    if (![Native]::SetWindowPos($h,[IntPtr]::Zero,$X,$Y,$Width,$Height,0x14)) { exit 3 }
} elseif (![Native]::SetForegroundWindow($h)) {
    exit 3
}
