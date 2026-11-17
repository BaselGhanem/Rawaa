param([ValidateSet('monitor','activate','place','resolve','list','watch-apps')][string]$Action, [string]$Target, [int]$X, [int]$Y, [int]$Width, [int]$Height, [uint32]$OwnerPid)
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
using System.Collections.Generic;
public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
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
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, Callback fn, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
    static string AppId(IntPtr hwnd) {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "";
        try {
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) != 122 || length == 0) return "";
            var id = new StringBuilder((int)length);
            return GetApplicationUserModelId(process, ref length, id) == 0 ? id.ToString() : "";
        } finally { CloseHandle(process); }
    }
    static string WindowAppId(IntPtr hwnd, string image) {
        if (!String.Equals(System.IO.Path.GetFileName(image), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
            return AppId(hwnd);
        uint host; GetWindowThreadProcessId(hwnd, out host);
        string id = "";
        EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr ignored) {
            uint pid; GetWindowThreadProcessId(child, out pid);
            if (pid == host) return true;
            id = AppId(child);
            return id.Length == 0;
        }, IntPtr.Zero);
        return id;
    }
    public static string[][] OpenApps(uint owner) {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var apps = new List<string[]>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            if (!IsWindowVisible(hwnd) || GetWindow(hwnd,4) != IntPtr.Zero) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid == owner) return true;
            int cloaked;
            if (DwmGetWindowAttribute(hwnd,14,out cloaked,4) == 0 && cloaked != 0) return true;
            var title = new StringBuilder(512);
            if (GetWindowText(hwnd,title,title.Capacity) == 0) return true;
            string image = Image(hwnd);
            string id = WindowAppId(hwnd, image);
            string target = id.Length > 0 ? "appx:" + id : image;
            if ((id.Length > 0 || image.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) && seen.Add(target))
                apps.Add(new string[] { target, image, title.ToString() });
            return true;
        }, IntPtr.Zero);
        return apps.ToArray();
    }
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
        bool packaged = target.StartsWith("appx:", StringComparison.OrdinalIgnoreCase);
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            if (IsWindowVisible(hwnd) && GetWindow(hwnd,4)==IntPtr.Zero &&
                String.Equals(packaged ? "appx:" + WindowAppId(hwnd, Image(hwnd)) : Image(hwnd), target, StringComparison.OrdinalIgnoreCase)) {
                result=hwnd; return false;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
if ($Action -eq 'list') {
    $startNames = @{}
    try {
        foreach ($app in Get-StartApps) { $startNames[$app.AppID] = $app.Name }
    } catch {}
    $apps = @(foreach ($entry in [Native]::OpenApps($OwnerPid)) {
        $target, $exe, $title = $entry
        $name = [IO.Path]::GetFileNameWithoutExtension($exe)
        if (!$target.StartsWith('appx:') -and $name -in @('ApplicationFrameHost', 'SystemSettings', 'TextInputHost', 'SearchHost', 'ShellExperienceHost', 'StartMenuExperienceHost')) { continue }
        if ($target.StartsWith('appx:')) {
            $id = $target.Substring(5)
            $name = if ($startNames.ContainsKey($id)) { $startNames[$id] } else { $title }
            if ($id -like 'Microsoft.WindowsCalculator_*!*') { $exe = Join-Path $env:SystemRoot 'System32\calc.exe' }
        } else {
            try {
                $description = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).FileDescription
                if (![string]::IsNullOrWhiteSpace($description)) { $name = $description.Trim() }
            } catch {}
        }
        [PSCustomObject]@{ name = $name; target = $target; iconPath = $exe }
    })
    ConvertTo-Json -InputObject @($apps | Sort-Object name | Select-Object -First 60) -Compress
    exit
}
[void][Native]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($Action -eq 'watch-apps') {
    $previous = ''
    while ($true) {
        try {
            $appIds = @(foreach ($entry in [Native]::OpenApps($OwnerPid)) {
                $entry[0]
                if ($entry[1] -and $entry[1] -notlike '*\ApplicationFrameHost.exe') { $entry[1] }
            })
            $snapshot = ConvertTo-Json -InputObject @($appIds | Sort-Object -Unique) -Compress
            if ($snapshot -ne $previous) {
                [Console]::WriteLine($snapshot)
                $previous = $snapshot
            }
        } catch {
            [Console]::Error.WriteLine($_.Exception.Message)
        }
        Start-Sleep -Milliseconds 1500
    }
}
if ($Action -eq 'monitor') {
    $pressed = $false
    $previous = ''
    while ($true) {
        $mouseDown = ([Native]::GetAsyncKeyState(1) -lt 0) -or ([Native]::GetAsyncKeyState(2) -lt 0)
        if ($mouseDown -and !$pressed) {
            $point = [Native+Point]::new()
            if ([Native]::GetCursorPos([ref]$point)) {
                [Console]::WriteLine(('click {0} {1}' -f $point.X,$point.Y))
            }
        }
        $pressed = $mouseDown
        $h = [Native]::GetForegroundWindow()
        $rect = [Native+Rect]::new()
        $class = [Text.StringBuilder]::new(256)
        [void][Native]::GetClassName($h, $class, 256)
        $skip = @('Progman','WorkerW','Shell_TrayWnd','Shell_SecondaryTrayWnd') -contains $class.ToString()
        if (!$skip -and ![Native]::IsZoomed($h) -and [Native]::GetWindowRect($h,[ref]$rect)) {
            $current = '{0} {1} {2} {3}' -f $rect.Left,$rect.Top,$rect.Right,$rect.Bottom
        } else { $current = 'none' }
        if ($current -ne $previous) {
            [Console]::WriteLine($current)
            $previous = $current
        }
        Start-Sleep -Milliseconds 35
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
