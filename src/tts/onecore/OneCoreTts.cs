// OneCoreTts.cs — 预编译 C# 小工具，用于在 Windows 上合成 OneCore 自然语音（Ayumi/Haruka/Ichiro）。
//
// 背景：Obsidian 插件原 Windows TTS 用 PowerShell 5.1 调 SAPI5 SpVoice（拼接音，效果差）。
// OneCore 自然语音需走 WinRT SpeechSynthesizer，但 PS 5.1 无法读取 WinRT 异步结果、
// pwsh 又缺 WinRT 投影程序集。本工具用 .NET Framework 4.x 原生 WinRT 互操作，
// 只依赖系统自带的 mscorlib / System.Runtime.WindowsRuntime / Windows 元数据，
// 无需任何额外运行时，可直接用系统 csc.exe 编译成约 5KB 的 exe 打包进插件。
//
// 编译（Windows 系统自带组件，含空格路径需引号）：
//   csc /nologo /target:exe /platform:x64
//       /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\mscorlib.dll
//       /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.dll
//       /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Core.dll
//       /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.dll
//       /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.InteropServices.WindowsRuntime.dll
//       /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.WindowsRuntime.dll
//       /reference:<Windows SDK UnionMetadata>\Windows.winmd
//       /out:onecore_tts.exe OneCoreTts.cs
//
// 命令行接口：
//   onecore_tts.exe list                      枚举所有 OneCore 语音，每行 VOICE|<DisplayName>|<Language>
//   onecore_tts.exe synth <ssml> <out> <voice> SSML 合成到 WAV（PCM 16kHz mono 16bit），成功输出 WAV|<path>|<bytes>

using System;
using System.IO;
using Windows.Media.SpeechSynthesis;
using Windows.Storage.Streams;

public static class OneCoreTts
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] == "list")
            {
                foreach (var v in SpeechSynthesizer.AllVoices)
                {
                    Console.WriteLine("VOICE|" + v.DisplayName + "|" + v.Language);
                }
                return 0;
            }

            if (args[0] == "synth")
            {
                // args: synth <ssml> <outPath> <voiceName>
                string ssml = args[1];
                string outPath = args[2];
                string voiceName = args.Length > 3 ? args[3] : "Ayumi";

                var synth = new SpeechSynthesizer();
                foreach (var v in SpeechSynthesizer.AllVoices)
                {
                    if (v.DisplayName.IndexOf(voiceName, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        synth.Voice = v;
                        break;
                    }
                }

                // .NET Framework 的 System.Runtime.WindowsRuntime 提供 AsTask 扩展，
                // 原生 WinRT 互操作，无需额外投影程序集。
                var stream = synth.SynthesizeSsmlToStreamAsync(ssml).AsTask().Result;

                var reader = new DataReader(stream.GetInputStreamAt(0));
                uint size = (uint)stream.Size;
                reader.LoadAsync(size).AsTask().GetAwaiter().GetResult();
                byte[] data = new byte[size];
                reader.ReadBytes(data);

                File.WriteAllBytes(outPath, data);
                Console.WriteLine("WAV|" + outPath + "|" + data.Length);
                return 0;
            }

            return 1;
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERR|" + ex.GetType().Name + "|" + ex.Message);
            return 2;
        }
    }
}
