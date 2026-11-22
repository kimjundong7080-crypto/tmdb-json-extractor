using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static string BaseDir()
    {
        return AppDomain.CurrentDomain.BaseDirectory;
    }

    private static string ReadSetting(string key)
    {
        try
        {
            string path = Path.Combine(BaseDir(), "launcher.ini");
            if (!File.Exists(path)) return "";
            foreach (string line in File.ReadAllLines(path))
            {
                int index = line.IndexOf('=');
                if (index <= 0) continue;
                if (line.Substring(0, index).Trim().Equals(key, StringComparison.OrdinalIgnoreCase))
                {
                    return line.Substring(index + 1).Trim();
                }
            }
        }
        catch
        {
        }
        return "";
    }

    private static string Quote(string value)
    {
        return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
    }

    private static int Main(string[] args)
    {
        try
        {
            string python = ReadSetting("python");
            string script = ReadSetting("script");
            string input = ReadSetting("input");
            string outDir = ReadSetting("out");
            string interval = ReadSetting("interval");

            if (script.Length == 0 || input.Length == 0) return 0;
            if (python.Length == 0) python = "pythonw.exe";
            if (interval.Length == 0) interval = "30";

            string arguments = Quote(script) + " " + Quote(input)
                + " --watch --interval " + interval;
            if (outDir.Length > 0) arguments += " --out " + Quote(outDir);

            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = python;
            info.Arguments = arguments;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            try { info.WorkingDirectory = Path.GetDirectoryName(script); } catch { }

            Process.Start(info);

            // Keep the native messaging channel open while Chrome is running.
            // The Python watcher keeps its own lock, so duplicate launches exit cleanly.
            try { Console.In.ReadToEnd(); } catch { }
            return 0;
        }
        catch
        {
            return 0;
        }
    }
}
