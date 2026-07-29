using Microsoft.UI.Xaml;

namespace NatuiHost;

/// <summary>Application theme resource lookup by string key.</summary>
internal static class Theme
{
    /// <summary>
    /// The theme resource stored under <paramref name="key"/>, or null when it
    /// is missing or has another type. The resource indexer throws on a
    /// missing key rather than returning null, so callers supply their own
    /// fallback with <c>??</c>.
    /// </summary>
    public static T? Resource<T>(string key)
        where T : class
    {
        try
        {
            return Application.Current.Resources[key] as T;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
