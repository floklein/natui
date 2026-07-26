using NatuiHost;
using Windows.UI;
using Xunit;

namespace NatuiHost.Tests;

/// <summary>
/// Protocol colors are #RRGGBB or #RRGGBBAA with alpha LAST. Anything that is
/// not exactly 6 or 8 hex digits is ignored rather than approximated.
/// </summary>
public class ColorFromHexTests
{
    [Theory]
    [InlineData("#4CAF50")]
    [InlineData("4caf50")]
    [InlineData("  #4CAF50  ")]
    public void SixDigitsAreOpaqueRgb(string hex)
    {
        Assert.Equal(Color.FromArgb(0xFF, 0x4C, 0xAF, 0x50), NodeMapper.ColorFromHex(hex));
    }

    [Fact]
    public void EightDigitsCarryAlphaLast()
    {
        Assert.Equal(
            Color.FromArgb(0x80, 0x4C, 0xAF, 0x50),
            NodeMapper.ColorFromHex("#4CAF5080"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("#")]
    [InlineData("#abc")]        // 3 digits
    [InlineData("#4CAF501")]    // 7 digits
    [InlineData("#4CAF5080AA")] // 10 digits
    [InlineData("12345Z")]      // non-hex digit
    [InlineData("0x123456")]    // 8 chars, but a C-style literal
    public void MalformedInputIsIgnored(string? hex)
    {
        Assert.Null(NodeMapper.ColorFromHex(hex));
    }
}
