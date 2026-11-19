// IBRA VPN — automatic browser-extension installer (same method as IBDM Pro).
// Browsers do not let programs install extensions silently from outside their stores, so this does what a person
// would do, by itself: opens the extensions page, turns on developer mode, presses "Load unpacked" and picks the folder.
//
// usage: ibra-ext-installer.exe <processName> <browserExe> <extensionsPage> <extensionDir>
//        ibra-ext-installer.exe --dump <processName>
// prints one line per step for the app:  STEP open | STEP type | STEP dev | STEP load | STEP folder | OK | FAIL <code> <detail>
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace IbraExtInstaller
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = Encoding.UTF8; } catch (Exception) { }
            if (args.Length >= 2 && args[0] == "--dump")
            {
                string text = "";
                var t = new Thread(() => text = Dump(args[1]));
                t.SetApartmentState(ApartmentState.MTA); t.Start(); t.Join();
                Console.WriteLine(text);
                return 0;
            }
            if (args.Length < 4) { Console.WriteLine("FAIL usage"); return 2; }
            int code = 1;
            // UI Automation must not run on an STA thread that owns windows.
            var th = new Thread(() => code = Install(args[0], args[1], args[2], args[3]));
            th.SetApartmentState(ApartmentState.MTA);
            th.Start();
            th.Join();
            return code;
        }

        private static void Say(string s) { Console.WriteLine(s); Console.Out.Flush(); }

        private sealed class FailException : Exception
        {
            public readonly string Code;
            public FailException(string code, string msg = "") : base(msg) { Code = code; }
        }

        private static int Install(string processName, string exe, string page, string extensionDir)
        {
            try
            {
                if (!File.Exists(Path.Combine(extensionDir, "manifest.json"))) throw new FailException("NO_DIR", extensionDir);
                if (!File.Exists(exe)) throw new FailException("NO_BROWSER", exe);

                Say("STEP open");
                var before = new HashSet<IntPtr>(BrowserWindows(processName).Select(w => w.Handle));
                var launched = DateTime.Now;
                StartBrowser(exe, "--no-first-run --no-default-browser-check --new-window " + page);

                AutomationElement window = null, devToggle = null;
                var until = DateTime.Now.AddSeconds(45);
                var navigatedAt = DateTime.MinValue;
                bool maximized = false, sideMenu = false;
                IntPtr windowHandle = IntPtr.Zero;
                int tries = 0;
                while (DateTime.Now < until && devToggle == null)
                {
                    Thread.Sleep(700);
                    var wins = BrowserWindows(processName).OrderByDescending(w => !before.Contains(w.Handle)).ToList();
                    if (wins.Count > 0 && !maximized && (DateTime.Now - launched).TotalSeconds > 2)
                    {
                        ShowWindow(wins[0].Handle, 3);
                        maximized = true;
                        Thread.Sleep(600);
                    }
                    foreach (var w in wins)
                    {
                        var el = Element(w.Handle);
                        if (el == null) continue;
                        var t = FindToggle(el);
                        // Edge hides developer mode inside the side menu when the window is narrow.
                        if (t == null && OpenSideMenu(el)) { Thread.Sleep(900); t = FindToggle(el); sideMenu = t != null; }
                        if (t != null) { window = el; devToggle = t; windowHandle = w.Handle; break; }
                    }
                    // Browsers often ignore chrome://… addresses on the command line: type it into the address bar.
                    if (devToggle == null && wins.Count > 0 && (DateTime.Now - navigatedAt).TotalSeconds > 8 && tries < 3)
                    {
                        if (tries == 0) Thread.Sleep(2500);
                        if (TypeAddress(wins[0].Handle, page)) Say("STEP type");
                        navigatedAt = DateTime.Now;
                        tries++;
                    }
                }
                if (window == null || devToggle == null) throw new FailException("NO_PAGE");
                try
                {
                    object wp;
                    if (window.TryGetCurrentPattern(WindowPattern.Pattern, out wp))
                        ((WindowPattern)wp).SetWindowVisualState(WindowVisualState.Maximized);
                }
                catch (Exception) { }

                Say("STEP dev");
                object tpo;
                if (devToggle.TryGetCurrentPattern(TogglePattern.Pattern, out tpo) && tpo is TogglePattern)
                {
                    var tp = (TogglePattern)tpo;
                    if (tp.Current.ToggleState != ToggleState.On) { tp.Toggle(); Thread.Sleep(900); }
                }
                else
                {
                    object ipo;
                    if (FindLoadUnpacked(window) == null && devToggle.TryGetCurrentPattern(InvokePattern.Pattern, out ipo))
                    {
                        // Brave: the switch is a clickable group without an on/off state.
                        ((InvokePattern)ipo).Invoke();
                        Thread.Sleep(900);
                        if (FindLoadUnpacked(window) == null) PressSpace(windowHandle, devToggle);
                        if (FindLoadUnpacked(window) == null) ClickOn(windowHandle, devToggle);
                    }
                }
                if (sideMenu)
                {
                    SetForegroundWindow(windowHandle);
                    Thread.Sleep(200);
                    System.Windows.Forms.SendKeys.SendWait("{ESC}");
                    Thread.Sleep(800);
                }

                Say("STEP load");
                AutomationElement load = null;
                until = DateTime.Now.AddSeconds(15);
                while (DateTime.Now < until && load == null)
                {
                    load = FindLoadUnpacked(window);
                    if (load == null) Thread.Sleep(500);
                }
                if (load == null) throw new FailException("NO_LOAD");
                var dialogsBefore = new HashSet<IntPtr>(Dialogs(processName));
                var target = load;
                // Invoke blocks while the modal folder dialog is open on some versions: press it from another thread.
                var press = new Thread(() =>
                {
                    try { ((InvokePattern)target.GetCurrentPattern(InvokePattern.Pattern)).Invoke(); }
                    catch (Exception) { }
                }) { IsBackground = true };
                press.SetApartmentState(ApartmentState.MTA);
                press.Start();

                Say("STEP folder");
                IntPtr dlg = IntPtr.Zero;
                until = DateTime.Now.AddSeconds(15);
                while (DateTime.Now < until && dlg == IntPtr.Zero)
                {
                    Thread.Sleep(400);
                    dlg = Dialogs(processName).FirstOrDefault(h => !dialogsBefore.Contains(h));
                }
                if (dlg == IntPtr.Zero) throw new FailException("NO_DIALOG");
                ChooseFolder(dlg, extensionDir);
                Thread.Sleep(1200);
                Say("OK");
                return 0;
            }
            catch (FailException e) { Say("FAIL " + e.Code + " " + e.Message); return 1; }
            catch (Exception e) { Say("FAIL ERROR " + e.Message.Replace('\n', ' ')); return 1; }
        }

        private static bool IsElevated()
        {
            try { return new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator); }
            catch (Exception) { return false; }
        }

        private static int Run(string file, string args)
        {
            try
            {
                var p = Process.Start(new ProcessStartInfo(file, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true });
                p.WaitForExit(15000);
                return p.HasExited ? p.ExitCode : -1;
            }
            catch (Exception) { return -1; }
        }

        /// <summary>Opens the browser as the normal user, never as administrator (the app itself may run elevated):
        /// a one-time Task Scheduler task with limited rights starts it in the person's session.</summary>
        private static void StartBrowser(string exe, string args)
        {
            if (IsElevated())
            {
                const string task = "IBRA VPN Browser";
                var tr = "\\\"" + exe + "\\\" " + args;
                if (Run("schtasks.exe", "/create /tn \"" + task + "\" /tr \"" + tr + "\" /sc once /st 23:59 /rl LIMITED /f") == 0
                    && Run("schtasks.exe", "/run /tn \"" + task + "\"") == 0)
                {
                    Thread.Sleep(2500);
                    Run("schtasks.exe", "/delete /tn \"" + task + "\" /f");
                    return;
                }
                Run("schtasks.exe", "/delete /tn \"" + task + "\" /f");
            }
            Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false });
        }

        private static bool OpenSideMenu(AutomationElement window)
        {
            try
            {
                string url = "";
                foreach (AutomationElement e in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)))
                {
                    object vp;
                    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { url = ((ValuePattern)vp).Current.Value ?? ""; break; }
                }
                if (!url.Contains("extensions")) return false;
                foreach (AutomationElement e in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsInvokePatternAvailableProperty, true)))
                {
                    var n = Norm(e.Current.Name);
                    var id = Norm(e.Current.AutomationId);
                    if (n.Contains("menu") || n.Contains("قائمه") || n.Contains("navigation") || n.Contains("تنقل") || id.Contains("menu") || id.Contains("hamburger"))
                    {
                        var r = e.Current.BoundingRectangle;
                        var wr = window.Current.BoundingRectangle;
                        if (r.Top < wr.Top + 90 || r.Top > wr.Top + 280 || r.Width > 80 || r.Left > wr.Left + 200) continue;
                        if (n.Contains("settings and more") || n.Contains("الاعدادات والمزيد")) continue;
                        ((InvokePattern)e.GetCurrentPattern(InvokePattern.Pattern)).Invoke();
                        return true;
                    }
                }
            }
            catch (Exception) { }
            return false;
        }

        private static bool TypeAddress(IntPtr window, string address)
        {
            try
            {
                var el = Element(window);
                if (el == null) return false;
                var edits = el.FindAll(TreeScope.Descendants, new AndCondition(
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                    new PropertyCondition(AutomationElement.IsValuePatternAvailableProperty, true)));
                AutomationElement bar = null;
                foreach (AutomationElement e in edits)
                {
                    var n = Norm(e.Current.Name);
                    if (n.Contains("address") || n.Contains("عنوان") || n.Contains("search") || n.Contains("بحث") || n.Contains("url")) { bar = e; break; }
                }
                if (bar == null && edits.Count > 0) bar = edits[0];
                SetForegroundWindow(window);
                Thread.Sleep(200);
                if (bar != null)
                {
                    try { bar.SetFocus(); } catch (Exception) { }
                    ((ValuePattern)bar.GetCurrentPattern(ValuePattern.Pattern)).SetValue(address);
                }
                else
                {
                    System.Windows.Forms.SendKeys.SendWait("^l");
                    Thread.Sleep(200);
                    System.Windows.Forms.SendKeys.SendWait(address);
                }
                Thread.Sleep(250);
                SetForegroundWindow(window);
                System.Windows.Forms.SendKeys.SendWait("{ENTER}");
                return true;
            }
            catch (Exception) { return false; }
        }

        private static string Norm(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder();
            foreach (var c in s.Normalize(NormalizationForm.FormD))
            {
                if ((c >= 'ً' && c <= 'ٟ') || c == 'ـ' || c == 'ٰ') continue;
                if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
                char o;
                if (c == 'أ' || c == 'إ' || c == 'آ') o = 'ا';
                else if (c == 'ة') o = 'ه';
                else if (c == 'ى') o = 'ي';
                else o = char.ToLowerInvariant(c);
                sb.Append(o);
            }
            return sb.ToString();
        }

        private static readonly string[] DevNames =
        {
            "developer mode", "وضع المطور", "وضع مطور", "مطور البرامج", "mode developpeur", "entwicklermodus", "modo de desarrollador",
            "modo desenvolvedor", "gelistirici modu", "режим разработчика", "حالت توسعه دهنده",
        };

        private static readonly string[] LoadNames =
        {
            "load unpacked", "unpacked", "غير مجمعه", "غير مجمع", "غير مضغوط", "غير محزم", "غير المضغوط", "charger l'extension non empaquetee",
            "entpackte erweiterung laden", "cargar descomprimida", "carregar sem compactacao", "paketlenmemis", "загрузить распакованное",
        };

        private static AutomationElement FindToggle(AutomationElement window)
        {
            try
            {
                foreach (AutomationElement e in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsTogglePatternAvailableProperty, true)))
                {
                    var id = Norm(e.Current.AutomationId);
                    var name = Norm(e.Current.Name);
                    if (id.Contains("devmode") || id.Contains("developer")) return e;
                    if (DevNames.Any(n => name.Contains(Norm(n)))) return e;
                }
                foreach (AutomationElement e in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsInvokePatternAvailableProperty, true)))
                {
                    if (Norm(e.Current.AutomationId).Contains("devmode")) return e;
                }
            }
            catch (Exception) { }
            return null;
        }

        private static AutomationElement FindLoadUnpacked(AutomationElement window)
        {
            try
            {
                foreach (AutomationElement e in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsInvokePatternAvailableProperty, true)))
                {
                    var id = Norm(e.Current.AutomationId);
                    var name = Norm(e.Current.Name);
                    if (id.Contains("loadunpacked") || id.Contains("load-unpacked")) return e;
                    if (LoadNames.Any(n => name.Contains(Norm(n)))) return e;
                }
            }
            catch (Exception) { }
            return null;
        }

        private static void ChooseFolder(IntPtr dialog, string folder)
        {
            var dlg = Element(dialog);
            if (dlg == null) throw new FailException("NO_DIALOG");
            AutomationElement edit = null;
            var until = DateTime.Now.AddSeconds(8);
            while (DateTime.Now < until && edit == null)
            {
                edit = dlg.FindFirst(TreeScope.Descendants, new AndCondition(
                           new PropertyCondition(AutomationElement.AutomationIdProperty, "1152"),
                           new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)))
                       ?? dlg.FindFirst(TreeScope.Descendants, new AndCondition(
                           new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit),
                           new PropertyCondition(AutomationElement.IsValuePatternAvailableProperty, true)));
                if (edit == null) Thread.Sleep(300);
            }
            if (edit == null) throw new FailException("NO_FOLDER_BOX");
            ((ValuePattern)edit.GetCurrentPattern(ValuePattern.Pattern)).SetValue(folder);
            Thread.Sleep(300);
            var ok = dlg.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.AutomationIdProperty, "1"),
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)));
            object ip;
            if (ok != null && ok.TryGetCurrentPattern(InvokePattern.Pattern, out ip)) ((InvokePattern)ip).Invoke();
            else
            {
                SetForegroundWindow(dialog);
                System.Windows.Forms.SendKeys.SendWait("{ENTER}");
            }
            // Some versions need a second confirmation (the first press opens the folder).
            Thread.Sleep(800);
            object ip2;
            if (IsWindow(dialog) && IsWindowVisible(dialog) && ok != null && ok.TryGetCurrentPattern(InvokePattern.Pattern, out ip2))
            {
                try { ((InvokePattern)ip2).Invoke(); } catch (Exception) { }
            }
        }

        private static string Dump(string processName)
        {
            var sb = new StringBuilder();
            foreach (var w in BrowserWindows(processName))
            {
                sb.AppendLine("window " + w.Handle + " " + w.Class);
                var el = Element(w.Handle);
                if (el == null) continue;
                try
                {
                    foreach (AutomationElement e in el.FindAll(TreeScope.Descendants, Condition.TrueCondition))
                    {
                        try
                        {
                            var c = e.Current;
                            if (string.IsNullOrWhiteSpace(c.Name) && string.IsNullOrWhiteSpace(c.AutomationId)) continue;
                            sb.AppendLine("  " + c.ControlType.ProgrammaticName + " id='" + c.AutomationId + "' name='" + c.Name + "' rect=" + c.BoundingRectangle);
                        }
                        catch (Exception) { }
                    }
                }
                catch (Exception ex) { sb.AppendLine("  error " + ex.Message); }
            }
            return sb.ToString();
        }

        private static AutomationElement Element(IntPtr h)
        {
            try { return AutomationElement.FromHandle(h); } catch (Exception) { return null; }
        }

        private sealed class Win
        {
            public IntPtr Handle; public string Class;
            public Win(IntPtr h, string c) { Handle = h; Class = c; }
        }

        private static List<Win> BrowserWindows(string processName)
        {
            var ids = new HashSet<uint>(Process.GetProcessesByName(processName).Select(p => (uint)p.Id));
            var list = new List<Win>();
            EnumWindows((h, l) =>
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (ids.Contains(pid) && IsWindowVisible(h))
                {
                    var cls = ClassOf(h);
                    if (cls.StartsWith("Chrome_WidgetWin")) list.Add(new Win(h, cls));
                }
                return true;
            }, IntPtr.Zero);
            return list;
        }

        private static List<IntPtr> Dialogs(string processName)
        {
            var ids = new HashSet<uint>(Process.GetProcessesByName(processName).Select(p => (uint)p.Id));
            var list = new List<IntPtr>();
            EnumWindows((h, l) =>
            {
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (ids.Contains(pid) && IsWindowVisible(h) && ClassOf(h) == "#32770") list.Add(h);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        private static string ClassOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        private static void PressSpace(IntPtr window, AutomationElement e)
        {
            try
            {
                SetForegroundWindow(window);
                Thread.Sleep(250);
                e.SetFocus();
                Thread.Sleep(250);
                System.Windows.Forms.SendKeys.SendWait(" ");
                Thread.Sleep(900);
            }
            catch (Exception) { }
        }

        private static void ClickOn(IntPtr window, AutomationElement e)
        {
            try
            {
                SetForegroundWindow(window);
                Thread.Sleep(250);
                var r = e.Current.BoundingRectangle;
                try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
                SetCursorPos((int)(r.Left + r.Width / 2), (int)(r.Top + r.Height / 2));
                Thread.Sleep(150);
                mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
                mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(900);
            }
            catch (Exception) { }
        }

        private delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
    }
}
