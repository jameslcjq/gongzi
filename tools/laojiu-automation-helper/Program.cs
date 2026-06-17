using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;
using Forms = System.Windows.Forms;

namespace Laojiu.AutomationHelper;

internal static class Program
{
    private const string DefaultScenario = "gongzi-login-key";
    private const string DefaultOutRoot = @"D:\laojiu\gzdata\debug\automation";
    private const int DefaultTimeoutSeconds = 20;
    private const int DefaultMaxTreeDepth = 6;
    private const int DefaultMaxTreeNodes = 800;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var command = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "help";
            var options = Args.Parse(args.Skip(1));

            object result = command switch
            {
                "list-windows" => ListWindowsCommand(),
                "dump-tree" => DumpTreeCommand(options),
                "find-combos" => FindCombosCommand(options),
                "screenshot" => ScreenshotCommand(options),
                "select-key" => SelectKeyCommand(options),
                "collect" => CollectCommand(options),
                "help" or "--help" or "-h" => HelpCommand(),
                _ => Error("unknown-command", $"未知命令：{command}")
            };

            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
            return GetOk(result) ? 0 : 2;
        }
        catch (Exception error)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine(JsonSerializer.Serialize(Error("fatal", error.Message), JsonOptions));
            return 1;
        }
    }

    private static object HelpCommand() => new
    {
        ok = true,
        name = "laojiu-automation-helper",
        commands = new[]
        {
            "collect --timeout 20 --scenario gongzi-login-key --out D:\\laojiu\\gzdata\\debug\\automation",
            "list-windows",
            "dump-tree --hwnd 0x001F08A2",
            "find-combos --hwnd 0x001F08A2",
            "screenshot --hwnd 0x001F08A2 --out D:\\laojiu\\gzdata\\debug\\automation",
            "select-key --key \"IdeaBank cKey 1\" --timeout 20"
        }
    };

    private static object ListWindowsCommand()
    {
        return new
        {
            ok = true,
            command = "list-windows",
            capturedAt = DateTimeOffset.Now,
            foregroundHwnd = Native.ToHex(Native.GetForegroundWindow()),
            windows = Native.ListTopLevelWindows().OrderByDescending(window => window.IsForeground).ThenByDescending(window => window.Score).ToList(),
            environment = CaptureEnvironment(),
            warnings = Array.Empty<string>()
        };
    }

    private static object DumpTreeCommand(Args options)
    {
        if (!options.TryGetHwnd(out var hwnd))
            return Error("missing-hwnd", "缺少 --hwnd 参数");

        var maxDepth = options.GetInt("max-depth", DefaultMaxTreeDepth);
        var maxNodes = options.GetInt("max-nodes", DefaultMaxTreeNodes);
        var warnings = new List<string>();
        var tree = BuildTree(hwnd, maxDepth, maxNodes, warnings);

        return new
        {
            ok = tree is not null,
            command = "dump-tree",
            hwnd = Native.ToHex(hwnd),
            tree,
            warnings,
            errors = tree is null ? new[] { "无法读取该窗口控件树" } : Array.Empty<string>()
        };
    }

    private static object FindCombosCommand(Args options)
    {
        if (!options.TryGetHwnd(out var hwnd))
            return Error("missing-hwnd", "缺少 --hwnd 参数");

        var warnings = new List<string>();
        var result = InspectControls(hwnd, expandComboBoxes: true, warnings);
        return new
        {
            ok = result.Errors.Count == 0,
            command = "find-combos",
            hwnd = Native.ToHex(hwnd),
            result.Combos,
            result.Lists,
            result.KeyCandidates,
            result.Buttons,
            warnings,
            errors = result.Errors
        };
    }

    private static object ScreenshotCommand(Args options)
    {
        if (!options.TryGetHwnd(out var hwnd))
            return Error("missing-hwnd", "缺少 --hwnd 参数");

        var outRoot = options.Get("out", DefaultOutRoot);
        Directory.CreateDirectory(outRoot);
        var filePath = Path.Combine(outRoot, $"window-{DateTime.Now:yyyyMMdd-HHmmss}-{Native.ToSafeHwnd(hwnd)}.png");
        var ok = CaptureWindow(hwnd, filePath, out var reason);

        return new
        {
            ok,
            command = "screenshot",
            hwnd = Native.ToHex(hwnd),
            path = ok ? filePath : null,
            errors = ok ? Array.Empty<string>() : new[] { reason ?? "截图失败" }
        };
    }

    private static object SelectKeyCommand(Args options)
    {
        var requestedKey = NormalizeText(options.Get("key", ""));
        var requestedIndex = options.GetInt("index", -1);
        // PIN 优先从环境变量读取，避免出现在进程命令行里（Task Manager / wmic 可见）。
        // 仍保留 --pin 作为手工调用时的兼容回退。
        var pin = Environment.GetEnvironmentVariable("LAOJIU_HELPER_PIN");
        if (string.IsNullOrWhiteSpace(pin)) pin = options.Get("pin", "");
        pin ??= "";
        var confirm = options.GetBool("confirm", false);
        if (string.IsNullOrWhiteSpace(requestedKey) && requestedIndex < 0)
            return Error("missing-target", "缺少 --key 或 --index 参数");
        if (confirm && string.IsNullOrWhiteSpace(pin))
            return Error("missing-pin", "自动确定前必须输入 PIN 码");

        var timeoutSeconds = Math.Clamp(options.GetInt("timeout", DefaultTimeoutSeconds), 1, 120);
        var timeline = new Timeline();
        var warnings = new List<string>();
        var errors = new List<string>();
        timeline.Add("select-start", $"key={requestedKey} index={requestedIndex} confirm={confirm} timeout={timeoutSeconds}s");

        IntPtr hwnd;
        WindowSummary? matched;
        if (options.TryGetHwnd(out hwnd))
        {
            matched = Native.ListTopLevelWindows()
                .FirstOrDefault(window => string.Equals(window.Hwnd, Native.ToHex(hwnd), StringComparison.OrdinalIgnoreCase));
            matched ??= new WindowSummary { Hwnd = Native.ToHex(hwnd), ModifiedAt = DateTimeOffset.Now };
            timeline.Add("window-from-hwnd", Native.ToHex(hwnd));
        }
        else
        {
            matched = WaitForLoginKeyWindow(timeoutSeconds, timeline);
            hwnd = matched is null ? IntPtr.Zero : Native.FromHex(matched.Hwnd);
        }

        if (hwnd == IntPtr.Zero || matched is null)
        {
            errors.Add("未在超时时间内发现疑似 Key / 证书选择窗口");
            return new
            {
                ok = false,
                command = "select-key",
                phase = "detect-window",
                reason = errors[0],
                requestedKey,
                requestedIndex = requestedIndex >= 0 ? requestedIndex : null as int?,
                warnings,
                errors,
                timeline = timeline.Items
            };
        }

        var before = InspectControls(hwnd, expandComboBoxes: true, warnings);
        errors.AddRange(before.Errors);
        var availableKeys = ExtractRealKeyOptions(before);
        var selectedIndex = requestedIndex >= 0 ? requestedIndex : FindKeyIndex(availableKeys, requestedKey);
        if (availableKeys.Count == 0)
            errors.Add("已找到证书选择窗口，但没有读取到可切换的 Key 候选项");
        if (selectedIndex < 0 || selectedIndex >= availableKeys.Count)
            errors.Add($"没有找到要切换的 Key：{requestedKey}");

        if (errors.Count > 0)
        {
            return new
            {
                ok = false,
                command = "select-key",
                phase = "resolve-key",
                reason = errors[0],
                requestedKey,
                requestedIndex = requestedIndex >= 0 ? requestedIndex : null as int?,
                matchedWindow = matched,
                beforeCurrentKey = CurrentKeyFromInspection(before),
                availableKeys,
                before.Combos,
                before.KeyCandidates,
                warnings,
                errors,
                timeline = timeline.Items
            };
        }

        var selectedText = availableKeys[selectedIndex];
        var method = "";
        string? reason;
        var ok = Native.SelectWin32ComboItem(hwnd, selectedIndex, selectedText, out reason);
        if (ok)
        {
            method = "Win32.ComboBox";
            timeline.Add("key-selected", $"method={method} index={selectedIndex} text={selectedText}");
        }
        else
        {
            warnings.Add(reason ?? "Win32 ComboBox 切换失败，改用 UI Automation");
            ok = TrySelectKeyByAutomation(hwnd, selectedText, selectedIndex, warnings, out reason);
            method = ok ? "UIAutomation.SelectionItem" : "";
            timeline.Add(ok ? "key-selected" : "key-select-failed", ok ? $"method={method} index={selectedIndex} text={selectedText}" : reason ?? "");
        }

        if (!ok)
            errors.Add(reason ?? $"无法切换到 {selectedText}");

        var pinFilled = false;
        var confirmed = false;
        if (ok && !string.IsNullOrWhiteSpace(pin))
        {
            pinFilled = Native.SetWin32EditText(hwnd, pin, out reason);
            if (!pinFilled)
            {
                warnings.Add(reason ?? "Win32 输入 PIN 失败，改用 UI Automation");
                pinFilled = TrySetPinByAutomation(hwnd, pin, warnings, out reason);
            }
            timeline.Add(pinFilled ? "pin-filled" : "pin-fill-failed", pinFilled ? "PIN 已输入" : reason ?? "");
            if (!pinFilled)
                errors.Add(reason ?? "无法输入 PIN 码");
        }

        if (ok && pinFilled && confirm)
        {
            confirmed = Native.ClickWin32Button(hwnd, "确定", out reason);
            if (!confirmed)
            {
                warnings.Add(reason ?? "Win32 点击确定失败，改用 UI Automation");
                confirmed = TryInvokeButtonByAutomation(hwnd, "确定", warnings, out reason);
            }
            timeline.Add(confirmed ? "confirm-clicked" : "confirm-click-failed", confirmed ? "已点击确定" : reason ?? "");
            if (!confirmed)
                errors.Add(reason ?? "无法点击确定");
        }

        Thread.Sleep(250);
        var after = confirmed ? new InspectionResult() : InspectControls(hwnd, expandComboBoxes: false, warnings);
        if (!confirmed)
            errors.AddRange(after.Errors);
        var afterCurrentKey = confirmed ? selectedText : CurrentKeyFromInspection(after);
        if (ok && string.IsNullOrWhiteSpace(afterCurrentKey))
            afterCurrentKey = selectedText;

        return new
        {
            ok = ok && errors.Count == 0,
            command = "select-key",
            phase = ok ? null : "select-key",
            reason = ok ? null : errors.FirstOrDefault(),
            requestedKey,
            requestedIndex = requestedIndex >= 0 ? requestedIndex : null as int?,
            selectedIndex,
            selectedText,
            method,
            pinFilled,
            confirmed,
            matchedWindow = matched,
            beforeCurrentKey = CurrentKeyFromInspection(before),
            afterCurrentKey,
            availableKeys,
            combos = after.Combos.Count > 0 ? after.Combos : before.Combos,
            keyCandidates = before.KeyCandidates.Select(candidate => new KeyCandidateSummary
            {
                Text = candidate.Text,
                Index = candidate.Index,
                ControlType = candidate.ControlType,
                Source = candidate.Source,
                IsSelected = string.Equals(NormalizeText(candidate.Text), NormalizeText(selectedText), StringComparison.OrdinalIgnoreCase),
                Patterns = candidate.Patterns,
                RoleGuess = candidate.RoleGuess,
                Score = candidate.Score
            }).ToList(),
            warnings,
            errors,
            timeline = timeline.Items
        };
    }

    private static object CollectCommand(Args options)
    {
        var scenario = options.Get("scenario", DefaultScenario);
        var timeoutSeconds = Math.Clamp(options.GetInt("timeout", DefaultTimeoutSeconds), 1, 120);
        var captureRoot = options.Get("out", DefaultOutRoot);
        var captureDir = Path.Combine(captureRoot, $"{DateTime.Now:yyyyMMdd-HHmmss}-{SanitizeSegment(scenario)}");
        Directory.CreateDirectory(captureDir);

        var timeline = new Timeline();
        var warnings = new List<string>();
        var errors = new List<string>();
        timeline.Add("collect-start", $"scenario={scenario} timeout={timeoutSeconds}s");

        var environment = CaptureEnvironment();
        WriteJson(Path.Combine(captureDir, "environment.json"), environment);

        var baseline = Native.ListTopLevelWindows();
        WriteJson(Path.Combine(captureDir, "windows-baseline.json"), baseline);
        timeline.Add("baseline-windows", $"count={baseline.Count}");

        WindowSummary? matched = null;
        var latest = baseline;
        var deadline = DateTimeOffset.Now.AddSeconds(timeoutSeconds);
        while (DateTimeOffset.Now < deadline)
        {
            latest = Native.ListTopLevelWindows();
            var candidates = latest
                .Select(window => window with { Score = ScoreLoginKeyWindow(window) })
                .Where(window => window.Score >= 35)
                .OrderByDescending(window => window.IsForeground)
                .ThenByDescending(window => window.Score)
                .ThenByDescending(window => window.ModifiedAt)
                .ToList();

            if (candidates.Count > 0)
            {
                matched = candidates[0] with
                {
                    ObservedAfterMs = (long)timeline.Elapsed.TotalMilliseconds
                };
                timeline.Add("window-detected", $"hwnd={matched.Hwnd} score={matched.Score} title={matched.Title}");
                break;
            }

            Thread.Sleep(300);
        }

        WriteJson(Path.Combine(captureDir, "windows.json"), latest);

        if (matched is null)
        {
            errors.Add("未在超时时间内发现疑似 Key / 证书选择窗口");
            timeline.Add("timeout", $"windows={latest.Count}");
            var fullPath = Path.Combine(captureDir, "fullscreen.png");
            if (CaptureFullScreen(fullPath, out var reason))
                timeline.Add("fullscreen-saved", Path.GetFileName(fullPath));
            else
                warnings.Add(reason ?? "全屏截图失败");

            var failure = new
            {
                ok = false,
                scenario,
                phase = "detect-window",
                reason = errors[0],
                captureDir,
                matchedWindow = (WindowSummary?)null,
                windows = latest,
                environment,
                screenshots = new { fullscreen = File.Exists(fullPath) ? fullPath : null as string },
                warnings,
                errors,
                timeline = timeline.Items
            };
            WriteJson(Path.Combine(captureDir, "capture.json"), failure);
            WriteTimeline(captureDir, timeline);
            var zip = BuildDiagnosticZip(captureDir);
            return new { failure.ok, failure.scenario, failure.phase, failure.reason, failure.captureDir, diagnosticZipPath = zip, warnings, errors };
        }

        var hwnd = Native.FromHex(matched.Hwnd);
        var windowPng = Path.Combine(captureDir, "window.png");
        if (CaptureWindow(hwnd, windowPng, out var windowShotReason))
            timeline.Add("window-screenshot-saved", "window.png");
        else
            warnings.Add(windowShotReason ?? "窗口截图失败");

        var treeBefore = BuildTree(hwnd, DefaultMaxTreeDepth, DefaultMaxTreeNodes, warnings);
        WriteJson(Path.Combine(captureDir, "window-tree-before-expand.json"), treeBefore);
        timeline.Add("tree-before-written", treeBefore is null ? "null" : "ok");

        var inspection = InspectControls(hwnd, expandComboBoxes: true, warnings);
        errors.AddRange(inspection.Errors);
        WriteJson(Path.Combine(captureDir, "key-candidates.json"), new
        {
            inspection.Combos,
            inspection.Lists,
            inspection.KeyCandidates,
            inspection.Buttons
        });
        timeline.Add("controls-inspected", $"combos={inspection.Combos.Count} keys={inspection.KeyCandidates.Count} buttons={inspection.Buttons.Count}");

        var expandedPng = Path.Combine(captureDir, "expanded.png");
        if (CaptureWindow(hwnd, expandedPng, out var expandedReason))
            timeline.Add("expanded-screenshot-saved", "expanded.png");
        else
            warnings.Add(expandedReason ?? "展开后窗口截图失败");

        var treeAfter = BuildTree(hwnd, DefaultMaxTreeDepth, DefaultMaxTreeNodes, warnings);
        WriteJson(Path.Combine(captureDir, "window-tree-after-expand.json"), treeAfter);

        var fullscreenPng = Path.Combine(captureDir, "fullscreen.png");
        if (CaptureFullScreen(fullscreenPng, out var fullReason))
            timeline.Add("fullscreen-saved", "fullscreen.png");
        else
            warnings.Add(fullReason ?? "全屏截图失败");

        if (inspection.Combos.Count == 0 && inspection.KeyCandidates.Count == 0)
            errors.Add("窗口已发现，但未读取到 ComboBox / ListItem 候选项");

        var result = new
        {
            ok = errors.Count == 0 || inspection.KeyCandidates.Count > 0 || inspection.Combos.Count > 0,
            scenario,
            captureDir,
            matchedWindow = matched,
            combos = inspection.Combos,
            lists = inspection.Lists,
            keyCandidates = inspection.KeyCandidates,
            buttons = inspection.Buttons,
            screenshots = new
            {
                window = File.Exists(windowPng) ? windowPng : null,
                expanded = File.Exists(expandedPng) ? expandedPng : null,
                fullscreen = File.Exists(fullscreenPng) ? fullscreenPng : null
            },
            environment,
            warnings,
            errors,
            timeline = timeline.Items
        };

        WriteJson(Path.Combine(captureDir, "capture.json"), result);
        WriteTimeline(captureDir, timeline);
        var zipPath = BuildDiagnosticZip(captureDir);
        timeline.Add("diagnostic-zip-written", zipPath);

        return new
        {
            result.ok,
            scenario,
            captureDir,
            diagnosticZipPath = zipPath,
            matchedWindow = matched,
            combos = inspection.Combos,
            keyCandidates = inspection.KeyCandidates,
            buttons = inspection.Buttons,
            comboCount = inspection.Combos.Count,
            keyCandidateCount = inspection.KeyCandidates.Count,
            buttonCount = inspection.Buttons.Count,
            result.screenshots,
            warnings,
            errors
        };
    }

    private static WindowSummary? WaitForLoginKeyWindow(int timeoutSeconds, Timeline timeline)
    {
        var deadline = DateTimeOffset.Now.AddSeconds(timeoutSeconds);
        while (DateTimeOffset.Now < deadline)
        {
            var candidates = Native.ListTopLevelWindows()
                .Select(window => window with { Score = ScoreLoginKeyWindow(window) })
                .Where(window => window.Score >= 35)
                .OrderByDescending(window => window.IsForeground)
                .ThenByDescending(window => window.Score)
                .ThenByDescending(window => window.ModifiedAt)
                .ToList();

            if (candidates.Count > 0)
            {
                var matched = candidates[0] with
                {
                    ObservedAfterMs = (long)timeline.Elapsed.TotalMilliseconds
                };
                timeline.Add("window-detected", $"hwnd={matched.Hwnd} score={matched.Score} title={matched.Title}");
                return matched;
            }

            Thread.Sleep(300);
        }

        timeline.Add("timeout", "未发现证书选择窗口");
        return null;
    }

    private static AutomationTreeNode? BuildTree(IntPtr hwnd, int maxDepth, int maxNodes, List<string> warnings)
    {
        try
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root is null) return null;

            var visited = 0;
            return BuildTreeNode(root, 0, maxDepth, maxNodes, ref visited, warnings);
        }
        catch (Exception error)
        {
            warnings.Add($"读取控件树失败：{error.Message}");
            return null;
        }
    }

    private static AutomationTreeNode BuildTreeNode(
        AutomationElement element,
        int depth,
        int maxDepth,
        int maxNodes,
        ref int visited,
        List<string> warnings)
    {
        visited++;
        var node = SummarizeElement(element);
        if (depth >= maxDepth || visited >= maxNodes) return node;

        try
        {
            var child = TreeWalker.RawViewWalker.GetFirstChild(element);
            while (child is not null && visited < maxNodes)
            {
                node.Children.Add(BuildTreeNode(child, depth + 1, maxDepth, maxNodes, ref visited, warnings));
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
        }
        catch (Exception error)
        {
            warnings.Add($"读取子控件失败：{error.Message}");
        }

        return node;
    }

    private static InspectionResult InspectControls(IntPtr hwnd, bool expandComboBoxes, List<string> warnings)
    {
        var result = new InspectionResult();
        try
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root is null)
            {
                result.Errors.Add("无法从 HWND 获取 UI Automation 根元素");
                return result;
            }

            var comboElements = FindByControlType(root, ControlType.ComboBox, warnings);
            foreach (var element in comboElements)
            {
                var summary = SummarizeElement(element).ToControlSummary();
                summary.Score = ScoreComboBox(element);
                summary.Items.AddRange(CollectItemsFromSubtree(element, warnings));

                if (expandComboBoxes)
                {
                    TryExpand(element, warnings);
                    Thread.Sleep(350);
                    summary.Items = CollectItemsFromSubtree(element, warnings);
                }

                result.Combos.Add(summary);
            }

            foreach (var element in FindByControlType(root, ControlType.List, warnings))
                result.Lists.Add(SummarizeElement(element).ToControlSummary());

            var candidateElements = FindCandidateItemElements(root, warnings);
            var win32Candidates = Native.ReadWin32ComboItems(hwnd);
            var candidates = new List<KeyCandidateSummary>();
            var index = 0;
            foreach (var element in candidateElements)
            {
                var text = ExtractText(element);
                if (string.IsNullOrWhiteSpace(text)) continue;
                candidates.Add(BuildKeyCandidate(element, text, index++, "UIAutomation"));
            }

            foreach (var item in win32Candidates)
            {
                if (string.IsNullOrWhiteSpace(item.Text)) continue;
                candidates.Add(new KeyCandidateSummary
                {
                    Text = item.Text.Trim(),
                    Index = index++,
                    ControlType = item.ControlType,
                    Source = item.Source,
                    IsSelected = null,
                    Patterns = Array.Empty<string>(),
                    RoleGuess = GuessRole(item.Text),
                    Score = ScoreCandidateText(item.Text)
                });
            }

            result.KeyCandidates = DeduplicateCandidates(candidates);

            foreach (var element in FindByControlType(root, ControlType.Button, warnings))
                result.Buttons.Add(SummarizeElement(element).ToControlSummary());
        }
        catch (Exception error)
        {
            result.Errors.Add(error.Message);
        }

        return result;
    }

    private static List<AutomationElement> FindByControlType(AutomationElement root, ControlType controlType, List<string> warnings)
    {
        try
        {
            return root
                .FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, controlType))
                .Cast<AutomationElement>()
                .Take(200)
                .ToList();
        }
        catch (Exception error)
        {
            warnings.Add($"查找 {controlType.ProgrammaticName} 失败：{error.Message}");
            return new List<AutomationElement>();
        }
    }

    private static List<AutomationElement> FindCandidateItemElements(AutomationElement root, List<string> warnings)
    {
        var controls = new[] { ControlType.ListItem, ControlType.DataItem, ControlType.Text };
        var result = new List<AutomationElement>();
        foreach (var control in controls)
            result.AddRange(FindByControlType(root, control, warnings));
        return result;
    }

    private static List<KeyCandidateSummary> DeduplicateCandidates(List<KeyCandidateSummary> candidates)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<KeyCandidateSummary>();
        foreach (var candidate in candidates.OrderByDescending(item => item.Score))
        {
            var text = NormalizeText(candidate.Text);
            if (text.Length < 2 || !seen.Add(text)) continue;
            result.Add(candidate);
        }
        return result.OrderBy(item => item.Index).ToList();
    }

    private static List<string> CollectItemsFromSubtree(AutomationElement element, List<string> warnings)
    {
        var items = new List<string>();
        foreach (var child in FindCandidateItemElements(element, warnings))
        {
            var text = ExtractText(child);
            if (!string.IsNullOrWhiteSpace(text)) items.Add(text.Trim());
        }
        return items.Distinct(StringComparer.OrdinalIgnoreCase).Take(100).ToList();
    }

    private static List<string> ExtractRealKeyOptions(InspectionResult inspection)
    {
        var comboItems = inspection.Combos
            .OrderByDescending(combo => combo.Score ?? 0)
            .SelectMany(combo => combo.Items)
            .Select(NormalizeText)
            .Where(IsLikelyKeyOption)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (comboItems.Count > 0) return comboItems;

        return inspection.KeyCandidates
            .Where(candidate => candidate.ControlType.Equals("ListItem", StringComparison.OrdinalIgnoreCase) || candidate.Score >= 60)
            .Select(candidate => NormalizeText(candidate.Text))
            .Where(IsLikelyKeyOption)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static bool IsLikelyKeyOption(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return false;
        if (text.Contains("PIN", StringComparison.OrdinalIgnoreCase)) return false;
        if (text.Contains("Key选择", StringComparison.OrdinalIgnoreCase)) return false;
        return text.Contains("Key", StringComparison.OrdinalIgnoreCase) || text.Contains("证书", StringComparison.OrdinalIgnoreCase);
    }

    private static int FindKeyIndex(List<string> availableKeys, string requestedKey)
    {
        var normalized = NormalizeText(requestedKey);
        if (string.IsNullOrWhiteSpace(normalized)) return -1;
        var exact = availableKeys.FindIndex(item => string.Equals(NormalizeText(item), normalized, StringComparison.OrdinalIgnoreCase));
        if (exact >= 0) return exact;
        return availableKeys.FindIndex(item => NormalizeText(item).Contains(normalized, StringComparison.OrdinalIgnoreCase));
    }

    private static string CurrentKeyFromInspection(InspectionResult inspection)
    {
        var current = inspection.Combos
            .OrderByDescending(combo => combo.Score ?? 0)
            .Select(combo => NormalizeText(combo.Name))
            .FirstOrDefault(IsLikelyKeyOption);
        return current ?? "";
    }

    private static bool TrySelectKeyByAutomation(
        IntPtr hwnd,
        string selectedText,
        int selectedIndex,
        List<string> warnings,
        out string? reason)
    {
        reason = null;
        try
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root is null)
            {
                reason = "无法从 HWND 获取 UI Automation 根元素";
                return false;
            }

            foreach (var combo in FindByControlType(root, ControlType.ComboBox, warnings).OrderByDescending(ScoreComboBox))
            {
                TryExpand(combo, warnings);
                Thread.Sleep(250);
                var items = FindByControlType(root, ControlType.ListItem, warnings)
                    .Select((element, index) => new { Element = element, Text = ExtractText(element), Index = index })
                    .Where(item => IsLikelyKeyOption(item.Text))
                    .ToList();
                var target = items.FirstOrDefault(item => string.Equals(NormalizeText(item.Text), NormalizeText(selectedText), StringComparison.OrdinalIgnoreCase))
                    ?? items.FirstOrDefault(item => item.Index == selectedIndex);
                if (target is null) continue;
                if (!target.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var patternObj)) continue;
                ((SelectionItemPattern)patternObj).Select();
                return true;
            }

            reason = $"没有找到可选择的列表项：{selectedText}";
            return false;
        }
        catch (Exception error)
        {
            reason = error.Message;
            return false;
        }
    }

    private static bool TrySetPinByAutomation(
        IntPtr hwnd,
        string pin,
        List<string> warnings,
        out string? reason)
    {
        reason = null;
        try
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root is null)
            {
                reason = "无法从 HWND 获取 UI Automation 根元素";
                return false;
            }

            foreach (var edit in FindByControlType(root, ControlType.Edit, warnings))
            {
                if (!edit.TryGetCurrentPattern(ValuePattern.Pattern, out var valueObj)) continue;
                ((ValuePattern)valueObj).SetValue(pin);
                return true;
            }

            reason = "未找到 PIN 输入框";
            return false;
        }
        catch (Exception error)
        {
            reason = error.Message;
            return false;
        }
    }

    private static bool TryInvokeButtonByAutomation(
        IntPtr hwnd,
        string buttonText,
        List<string> warnings,
        out string? reason)
    {
        reason = null;
        try
        {
            var root = AutomationElement.FromHandle(hwnd);
            if (root is null)
            {
                reason = "无法从 HWND 获取 UI Automation 根元素";
                return false;
            }

            foreach (var button in FindByControlType(root, ControlType.Button, warnings))
            {
                var text = ExtractText(button);
                if (!text.Contains(buttonText, StringComparison.OrdinalIgnoreCase)) continue;
                if (!button.TryGetCurrentPattern(InvokePattern.Pattern, out var invokeObj)) continue;
                ((InvokePattern)invokeObj).Invoke();
                return true;
            }

            reason = $"未找到按钮：{buttonText}";
            return false;
        }
        catch (Exception error)
        {
            reason = error.Message;
            return false;
        }
    }

    private static void TryExpand(AutomationElement element, List<string> warnings)
    {
        try
        {
            if (!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var patternObj)) return;
            var pattern = (ExpandCollapsePattern)patternObj;
            if (pattern.Current.ExpandCollapseState != ExpandCollapseState.Expanded)
                pattern.Expand();
        }
        catch (Exception error)
        {
            warnings.Add($"展开 ComboBox 失败：{error.Message}");
        }
    }

    private static AutomationTreeNode SummarizeElement(AutomationElement element)
    {
        var safe = new SafeAutomationElement(element);
        var isPassword = safe.GetBool(AutomationElement.IsPasswordProperty);
        var rect = safe.GetRect();
        return new AutomationTreeNode
        {
            ControlType = CleanControlType(safe.GetControlType()),
            LocalizedControlType = safe.GetString(AutomationElement.LocalizedControlTypeProperty),
            Name = isPassword ? "[password]" : safe.GetString(AutomationElement.NameProperty),
            AutomationId = safe.GetString(AutomationElement.AutomationIdProperty),
            ClassName = safe.GetString(AutomationElement.ClassNameProperty),
            IsEnabled = safe.GetBool(AutomationElement.IsEnabledProperty),
            IsOffscreen = safe.GetBool(AutomationElement.IsOffscreenProperty),
            HasKeyboardFocus = safe.GetBool(AutomationElement.HasKeyboardFocusProperty),
            IsPassword = isPassword,
            BoundingRectangle = rect,
            Patterns = safe.GetPatterns()
        };
    }

    private static KeyCandidateSummary BuildKeyCandidate(AutomationElement element, string text, int index, string source)
    {
        var summary = SummarizeElement(element);
        return new KeyCandidateSummary
        {
            Text = text.Trim(),
            Index = index,
            ControlType = summary.ControlType ?? "",
            Source = source,
            IsSelected = TryGetSelectionState(element),
            Patterns = summary.Patterns,
            RoleGuess = GuessRole(text),
            Score = ScoreCandidateText(text)
        };
    }

    private static bool? TryGetSelectionState(AutomationElement element)
    {
        try
        {
            if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var patternObj))
                return ((SelectionItemPattern)patternObj).Current.IsSelected;
        }
        catch
        {
            return null;
        }

        return null;
    }

    private static string ExtractText(AutomationElement element)
    {
        var safe = new SafeAutomationElement(element);
        if (safe.GetBool(AutomationElement.IsPasswordProperty)) return "";

        var parts = new List<string>();
        AddText(parts, safe.GetString(AutomationElement.NameProperty));

        try
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valueObj))
                AddText(parts, ((ValuePattern)valueObj).Current.Value);
        }
        catch
        {
        }

        return NormalizeText(string.Join(" ", parts));
    }

    private static void AddText(List<string> parts, string? text)
    {
        if (!string.IsNullOrWhiteSpace(text)) parts.Add(text.Trim());
    }

    private static int ScoreLoginKeyWindow(WindowSummary window)
    {
        var score = 0;
        var haystack = $"{window.Title} {window.ClassName} {window.ProcessName}".ToLowerInvariant();
        if (window.IsForeground) score += 25;
        if (window.ClassName == "#32770") score += 20;
        foreach (var keyword in new[] { "证书", "ukey", "u-key", "key", "登录", "登陆", "ca", "请选择", "usbkey", "数字证书" })
        {
            if (haystack.Contains(keyword.ToLowerInvariant())) score += 18;
        }
        foreach (var keyword in new[] { "老九的工资系统", "electron", "salary-system" })
        {
            if (haystack.Contains(keyword.ToLowerInvariant())) score -= 35;
        }
        if (window.Rect.Width is > 120 and < 1200 && window.Rect.Height is > 80 and < 900) score += 8;
        return Math.Clamp(score, 0, 100);
    }

    private static int ScoreComboBox(AutomationElement element)
    {
        var score = 30;
        var text = ExtractText(element).ToLowerInvariant();
        foreach (var keyword in new[] { "key", "证书", "登录", "登陆", "单位", "ukey" })
        {
            if (text.Contains(keyword)) score += 15;
        }
        try
        {
            if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _)) score += 20;
            if (element.TryGetCurrentPattern(SelectionPattern.Pattern, out _)) score += 15;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out _)) score += 10;
        }
        catch
        {
        }
        return Math.Clamp(score, 0, 100);
    }

    private static int ScoreCandidateText(string text)
    {
        var score = 10;
        if (text.Any(char.IsDigit)) score += 20;
        if (text.Contains("经办")) score += 30;
        if (text.Contains("审核") || text.Contains("复核")) score += 30;
        if (text.Contains("Key", StringComparison.OrdinalIgnoreCase) || text.Contains("证书")) score += 20;
        if (text.Length >= 8) score += 10;
        return Math.Clamp(score, 0, 100);
    }

    private static string GuessRole(string text)
    {
        if (text.Contains("经办")) return "operator";
        if (text.Contains("审核") || text.Contains("复核")) return "reviewer";
        return "unknown";
    }

    private static string CleanControlType(string? controlType)
    {
        if (string.IsNullOrWhiteSpace(controlType)) return "";
        return controlType.StartsWith("ControlType.", StringComparison.Ordinal)
            ? controlType["ControlType.".Length..]
            : controlType;
    }

    private static string NormalizeText(string text) =>
        string.Join(" ", (text ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();

    private static bool CaptureWindow(IntPtr hwnd, string filePath, out string? reason)
    {
        reason = null;
        try
        {
            if (!Native.GetWindowRect(hwnd, out var rect))
            {
                reason = "无法读取窗口位置";
                return false;
            }

            var width = Math.Max(1, rect.Right - rect.Left);
            var height = Math.Max(1, rect.Bottom - rect.Top);
            using var bitmap = new Bitmap(width, height);
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
            bitmap.Save(filePath, ImageFormat.Png);
            return true;
        }
        catch (Exception error)
        {
            reason = error.Message;
            return false;
        }
    }

    private static bool CaptureFullScreen(string filePath, out string? reason)
    {
        reason = null;
        try
        {
            var bounds = Forms.Screen.AllScreens
                .Select(screen => screen.Bounds)
                .Aggregate(Rectangle.Union);
            using var bitmap = new Bitmap(bounds.Width, bounds.Height);
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size);
            bitmap.Save(filePath, ImageFormat.Png);
            return true;
        }
        catch (Exception error)
        {
            reason = error.Message;
            return false;
        }
    }

    private static EnvironmentSummary CaptureEnvironment()
    {
        var screens = Forms.Screen.AllScreens.Select(screen => new ScreenSummary
        {
            DeviceName = screen.DeviceName,
            Primary = screen.Primary,
            Bounds = RectSummary.FromRectangle(screen.Bounds),
            WorkingArea = RectSummary.FromRectangle(screen.WorkingArea)
        }).ToList();

        return new EnvironmentSummary
        {
            CapturedAt = DateTimeOffset.Now,
            WindowsVersion = RuntimeInformation.OSDescription,
            IsHelperElevated = IsElevated(),
            SessionId = Process.GetCurrentProcess().SessionId,
            DpiScale = Native.GetDpiScale(),
            ScreenCount = screens.Count,
            Screens = screens,
            HelperBitness = Environment.Is64BitProcess ? "x64" : "x86",
            CurrentProcessId = Environment.ProcessId
        };
    }

    private static bool IsElevated()
    {
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    private static string BuildDiagnosticZip(string captureDir)
    {
        var zipPath = Path.Combine(Path.GetDirectoryName(captureDir) ?? captureDir, $"login-key-diagnostic-{Path.GetFileName(captureDir)}.zip");
        if (File.Exists(zipPath)) File.Delete(zipPath);
        using var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create);
        foreach (var filePath in Directory.EnumerateFiles(captureDir, "*", SearchOption.AllDirectories))
        {
            var entryName = Path.GetRelativePath(captureDir, filePath);
            archive.CreateEntryFromFile(filePath, entryName, CompressionLevel.Optimal);
        }
        return zipPath;
    }

    private static void WriteJson(string filePath, object? value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
        File.WriteAllText(filePath, JsonSerializer.Serialize(value, JsonOptions) + Environment.NewLine, Encoding.UTF8);
    }

    private static void WriteTimeline(string captureDir, Timeline timeline)
    {
        var lines = timeline.Items.Select(item => $"{item.ElapsedMs}ms\t{item.Event}\t{item.Detail}".TrimEnd());
        File.WriteAllLines(Path.Combine(captureDir, "timeline.log"), lines, Encoding.UTF8);
    }

    private static string SanitizeSegment(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var chars = value.Select(ch => invalid.Contains(ch) ? '-' : ch).ToArray();
        var cleaned = new string(chars).Trim('-', ' ', '.');
        return string.IsNullOrWhiteSpace(cleaned) ? "capture" : cleaned;
    }

    private static object Error(string phase, string reason) => new
    {
        ok = false,
        phase,
        reason,
        errors = new[] { reason }
    };

    private static bool GetOk(object result)
    {
        var property = result.GetType().GetProperty("ok");
        return property?.GetValue(result) is bool ok && ok;
    }
}

internal sealed class Args
{
    private readonly Dictionary<string, string> _values;

    private Args(Dictionary<string, string> values) => _values = values;

    public static Args Parse(IEnumerable<string> args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var list = args.ToList();
        for (var i = 0; i < list.Count; i++)
        {
            var token = list[i];
            if (!token.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = token[2..];
            var value = "true";
            if (i + 1 < list.Count && !list[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                value = list[i + 1];
                i++;
            }
            values[key] = value;
        }
        return new Args(values);
    }

    public string Get(string key, string fallback) =>
        _values.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    public int GetInt(string key, int fallback) =>
        _values.TryGetValue(key, out var value) && int.TryParse(value, out var parsed) ? parsed : fallback;

    public bool GetBool(string key, bool fallback)
    {
        if (!_values.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value)) return fallback;
        if (bool.TryParse(value, out var parsed)) return parsed;
        return value is "1" or "yes" or "y" or "on";
    }

    public bool TryGetHwnd(out IntPtr hwnd)
    {
        hwnd = IntPtr.Zero;
        if (!_values.TryGetValue("hwnd", out var value) || string.IsNullOrWhiteSpace(value)) return false;
        hwnd = Native.FromHex(value);
        return hwnd != IntPtr.Zero;
    }
}

internal static class Native
{
    private const int GwlExStyle = -20;
    private const int WsExToolWindow = 0x00000080;
    private const int LogPixelsX = 88;
    private const int CbGetCount = 0x0146;
    private const int CbGetCurSel = 0x0147;
    private const int CbGetLbText = 0x0148;
    private const int CbGetLbTextLen = 0x0149;
    private const int CbSetCurSel = 0x014E;
    private const int LbGetCount = 0x018B;
    private const int LbGetText = 0x0189;
    private const int LbGetTextLen = 0x018A;
    private const int WmSetText = 0x000C;
    private const int WmCommand = 0x0111;
    private const int BmClick = 0x00F5;
    private const int CbnSelChange = 1;

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr hwndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int count);

    [DllImport("user32.dll")]
    internal static extern bool GetWindowRect(IntPtr hwnd, out WinRect rect);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern int GetDlgCtrlID(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern int GetDeviceCaps(IntPtr hdc, int index);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, StringBuilder lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, string lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    public static List<WindowSummary> ListTopLevelWindows()
    {
        var foreground = GetForegroundWindow();
        var windows = new List<WindowSummary>();
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            var title = GetText(hwnd);
            var className = GetClass(hwnd);
            if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(className)) return true;
            if ((GetWindowLong(hwnd, GwlExStyle) & WsExToolWindow) != 0 && string.IsNullOrWhiteSpace(title)) return true;
            GetWindowThreadProcessId(hwnd, out var processId);
            GetWindowRect(hwnd, out var rect);

            windows.Add(new WindowSummary
            {
                Hwnd = ToHex(hwnd),
                Title = title,
                ClassName = className,
                ProcessId = (int)processId,
                ProcessName = GetProcessName((int)processId),
                ThreadId = null,
                IsVisible = true,
                IsForeground = hwnd == foreground,
                Rect = RectSummary.FromWinRect(rect),
                Score = 0,
                ModifiedAt = DateTimeOffset.Now
            });
            return true;
        }, IntPtr.Zero);

        return windows;
    }

    public static List<Win32CandidateItem> ReadWin32ComboItems(IntPtr hwnd)
    {
        var items = new List<Win32CandidateItem>();
        EnumChildWindows(hwnd, (child, _) =>
        {
            var className = GetClass(child);
            if (className.Contains("ComboBox", StringComparison.OrdinalIgnoreCase))
                items.AddRange(ReadItems(child, CbGetCount, CbGetLbTextLen, CbGetLbText, "ComboBox", "Win32.ComboBox"));
            else if (className.Contains("ListBox", StringComparison.OrdinalIgnoreCase))
                items.AddRange(ReadItems(child, LbGetCount, LbGetTextLen, LbGetText, "ListItem", "Win32.ListBox"));
            return true;
        }, IntPtr.Zero);
        return items;
    }

    public static bool SelectWin32ComboItem(IntPtr parentHwnd, int targetIndex, string targetText, out string? reason)
    {
        reason = null;
        var combos = new List<IntPtr>();
        EnumChildWindows(parentHwnd, (child, _) =>
        {
            var className = GetClass(child);
            if (className.Contains("ComboBox", StringComparison.OrdinalIgnoreCase))
                combos.Add(child);
            return true;
        }, IntPtr.Zero);

        foreach (var combo in combos)
        {
            var items = ReadItems(combo, CbGetCount, CbGetLbTextLen, CbGetLbText, "ComboBox", "Win32.ComboBox")
                .Select(item => item.Text.Trim())
                .ToList();
            if (targetIndex < 0 || targetIndex >= items.Count) continue;
            if (!string.IsNullOrWhiteSpace(targetText)
                && !string.Equals(items[targetIndex], targetText, StringComparison.OrdinalIgnoreCase))
            {
                var exact = items.FindIndex(item => string.Equals(item, targetText, StringComparison.OrdinalIgnoreCase));
                if (exact < 0) continue;
                targetIndex = exact;
            }

            SendMessage(combo, CbSetCurSel, new IntPtr(targetIndex), IntPtr.Zero);
            var selected = SendMessage(combo, CbGetCurSel, IntPtr.Zero, IntPtr.Zero).ToInt32();
            var controlId = GetDlgCtrlID(combo);
            var command = (CbnSelChange << 16) | (controlId & 0xffff);
            SendMessage(parentHwnd, WmCommand, new IntPtr(command), combo);
            if (selected == targetIndex) return true;
        }

        reason = combos.Count == 0 ? "未找到 Win32 ComboBox 控件" : $"Win32 ComboBox 无法切换到序号 {targetIndex}";
        return false;
    }

    public static bool SetWin32EditText(IntPtr parentHwnd, string value, out string? reason)
    {
        reason = null;
        var edits = new List<IntPtr>();
        EnumChildWindows(parentHwnd, (child, _) =>
        {
            var className = GetClass(child);
            if (className.Contains("Edit", StringComparison.OrdinalIgnoreCase))
                edits.Add(child);
            return true;
        }, IntPtr.Zero);

        foreach (var edit in edits)
        {
            SendMessage(edit, WmSetText, IntPtr.Zero, value);
            return true;
        }

        reason = "未找到 Win32 PIN 输入框";
        return false;
    }

    public static bool ClickWin32Button(IntPtr parentHwnd, string buttonText, out string? reason)
    {
        reason = null;
        var buttons = new List<IntPtr>();
        EnumChildWindows(parentHwnd, (child, _) =>
        {
            var className = GetClass(child);
            if (className.Contains("Button", StringComparison.OrdinalIgnoreCase)
                && GetText(child).Contains(buttonText, StringComparison.OrdinalIgnoreCase))
            {
                buttons.Add(child);
            }
            return true;
        }, IntPtr.Zero);

        foreach (var button in buttons)
        {
            SendMessage(button, BmClick, IntPtr.Zero, IntPtr.Zero);
            return true;
        }

        reason = $"未找到 Win32 按钮：{buttonText}";
        return false;
    }

    private static IEnumerable<Win32CandidateItem> ReadItems(
        IntPtr hwnd,
        int countMessage,
        int textLengthMessage,
        int textMessage,
        string controlType,
        string source)
    {
        var count = SendMessage(hwnd, countMessage, IntPtr.Zero, IntPtr.Zero).ToInt32();
        if (count <= 0 || count > 200) yield break;

        for (var i = 0; i < count; i++)
        {
            var length = SendMessage(hwnd, textLengthMessage, new IntPtr(i), IntPtr.Zero).ToInt32();
            if (length <= 0 || length > 4096) continue;
            var buffer = new StringBuilder(length + 1);
            SendMessage(hwnd, textMessage, new IntPtr(i), buffer);
            var text = buffer.ToString();
            if (!string.IsNullOrWhiteSpace(text))
                yield return new Win32CandidateItem(text, controlType, source);
        }
    }

    public static double GetDpiScale()
    {
        var dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return 1;
        try
        {
            return Math.Round(GetDeviceCaps(dc, LogPixelsX) / 96d, 2);
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, dc);
        }
    }

    public static string ToHex(IntPtr hwnd) => $"0x{hwnd.ToInt64():X8}";

    public static string ToSafeHwnd(IntPtr hwnd) => hwnd.ToInt64().ToString("X8");

    public static IntPtr FromHex(string value)
    {
        value = value.Trim();
        if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) value = value[2..];
        return long.TryParse(value, System.Globalization.NumberStyles.HexNumber, null, out var parsed)
            ? new IntPtr(parsed)
            : IntPtr.Zero;
    }

    private static string GetText(IntPtr hwnd)
    {
        var buffer = new StringBuilder(512);
        GetWindowText(hwnd, buffer, buffer.Capacity);
        return buffer.ToString().Trim();
    }

    private static string GetClass(IntPtr hwnd)
    {
        var buffer = new StringBuilder(256);
        GetClassName(hwnd, buffer, buffer.Capacity);
        return buffer.ToString().Trim();
    }

    private static string GetProcessName(int processId)
    {
        try
        {
            return Process.GetProcessById(processId).ProcessName;
        }
        catch
        {
            return "";
        }
    }
}

internal sealed class SafeAutomationElement
{
    private readonly AutomationElement _element;

    public SafeAutomationElement(AutomationElement element) => _element = element;

    public string GetString(AutomationProperty property)
    {
        try
        {
            return _element.GetCurrentPropertyValue(property, true) as string ?? "";
        }
        catch
        {
            return "";
        }
    }

    public bool GetBool(AutomationProperty property)
    {
        try
        {
            return _element.GetCurrentPropertyValue(property, true) is bool value && value;
        }
        catch
        {
            return false;
        }
    }

    public string GetControlType()
    {
        try
        {
            return (_element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true) as ControlType)?.ProgrammaticName ?? "";
        }
        catch
        {
            return "";
        }
    }

    public RectSummary GetRect()
    {
        try
        {
            if (_element.GetCurrentPropertyValue(AutomationElement.BoundingRectangleProperty, true) is not System.Windows.Rect rect)
                return RectSummary.Empty;
            return new RectSummary
            {
                Left = (int)Math.Round(rect.Left),
                Top = (int)Math.Round(rect.Top),
                Width = (int)Math.Round(rect.Width),
                Height = (int)Math.Round(rect.Height)
            };
        }
        catch
        {
            return RectSummary.Empty;
        }
    }

    public string[] GetPatterns()
    {
        try
        {
            return _element.GetSupportedPatterns()
                .Select(pattern => pattern.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "", StringComparison.Ordinal))
                .Select(pattern => pattern.Replace("PatternIdentifiers.", "", StringComparison.Ordinal))
                .Select(pattern => pattern.Replace("Pattern", "", StringComparison.Ordinal))
                .Distinct()
                .OrderBy(pattern => pattern)
                .ToArray();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }
}

internal sealed class Timeline
{
    private readonly Stopwatch _stopwatch = Stopwatch.StartNew();
    public TimeSpan Elapsed => _stopwatch.Elapsed;
    public List<TimelineItem> Items { get; } = new();
    public void Add(string @event, string detail = "") =>
        Items.Add(new TimelineItem((long)_stopwatch.Elapsed.TotalMilliseconds, @event, detail));
}

internal sealed record TimelineItem(long ElapsedMs, string Event, string Detail);

internal sealed record Win32CandidateItem(string Text, string ControlType, string Source);

[StructLayout(LayoutKind.Sequential)]
internal struct WinRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

internal sealed record WindowSummary
{
    public string Hwnd { get; init; } = "";
    public string Title { get; init; } = "";
    public string ClassName { get; init; } = "";
    public int ProcessId { get; init; }
    public string ProcessName { get; init; } = "";
    public int? ThreadId { get; init; }
    public bool IsVisible { get; init; }
    public bool IsForeground { get; init; }
    public RectSummary Rect { get; init; } = RectSummary.Empty;
    public int Score { get; init; }
    public long? ObservedAfterMs { get; init; }
    public DateTimeOffset ModifiedAt { get; init; }
}

internal sealed class AutomationTreeNode
{
    public string? ControlType { get; set; }
    public string? LocalizedControlType { get; set; }
    public string? Name { get; set; }
    public string? AutomationId { get; set; }
    public string? ClassName { get; set; }
    public bool IsEnabled { get; set; }
    public bool IsOffscreen { get; set; }
    public bool HasKeyboardFocus { get; set; }
    public bool IsPassword { get; set; }
    public RectSummary BoundingRectangle { get; set; } = RectSummary.Empty;
    public string[] Patterns { get; set; } = Array.Empty<string>();
    public List<AutomationTreeNode> Children { get; set; } = new();

    public ControlSummary ToControlSummary() => new()
    {
        ControlType = ControlType ?? "",
        LocalizedControlType = LocalizedControlType ?? "",
        Name = Name ?? "",
        AutomationId = AutomationId ?? "",
        ClassName = ClassName ?? "",
        BoundingRectangle = BoundingRectangle,
        Patterns = Patterns
    };
}

internal sealed class ControlSummary
{
    public string ControlType { get; set; } = "";
    public string LocalizedControlType { get; set; } = "";
    public string Name { get; set; } = "";
    public string AutomationId { get; set; } = "";
    public string ClassName { get; set; } = "";
    public RectSummary BoundingRectangle { get; set; } = RectSummary.Empty;
    public string[] Patterns { get; set; } = Array.Empty<string>();
    public int? Score { get; set; }
    public List<string> Items { get; set; } = new();
}

internal sealed class KeyCandidateSummary
{
    public string Text { get; set; } = "";
    public int Index { get; set; }
    public string ControlType { get; set; } = "";
    public string Source { get; set; } = "";
    public bool? IsSelected { get; set; }
    public string[] Patterns { get; set; } = Array.Empty<string>();
    public string RoleGuess { get; set; } = "unknown";
    public int Score { get; set; }
}

internal sealed class InspectionResult
{
    public List<ControlSummary> Combos { get; set; } = new();
    public List<ControlSummary> Lists { get; set; } = new();
    public List<KeyCandidateSummary> KeyCandidates { get; set; } = new();
    public List<ControlSummary> Buttons { get; set; } = new();
    public List<string> Errors { get; set; } = new();
}

internal sealed class EnvironmentSummary
{
    public DateTimeOffset CapturedAt { get; set; }
    public string WindowsVersion { get; set; } = "";
    public bool IsHelperElevated { get; set; }
    public int SessionId { get; set; }
    public double DpiScale { get; set; }
    public int ScreenCount { get; set; }
    public List<ScreenSummary> Screens { get; set; } = new();
    public string HelperBitness { get; set; } = "";
    public int CurrentProcessId { get; set; }
}

internal sealed class ScreenSummary
{
    public string DeviceName { get; set; } = "";
    public bool Primary { get; set; }
    public RectSummary Bounds { get; set; } = RectSummary.Empty;
    public RectSummary WorkingArea { get; set; } = RectSummary.Empty;
}

internal sealed class RectSummary
{
    public static RectSummary Empty => new();
    public int Left { get; set; }
    public int Top { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }

    public static RectSummary FromWinRect(WinRect rect) => new()
    {
        Left = rect.Left,
        Top = rect.Top,
        Width = Math.Max(0, rect.Right - rect.Left),
        Height = Math.Max(0, rect.Bottom - rect.Top)
    };

    public static RectSummary FromRectangle(Rectangle rect) => new()
    {
        Left = rect.Left,
        Top = rect.Top,
        Width = rect.Width,
        Height = rect.Height
    };
}
