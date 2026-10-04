#pragma once
#include <string_view>
namespace lpmas {
enum class PortalAccess { allow, forbidden, unavailable };
inline PortalAccess portalAccess(bool viaSetupWifi, std::string_view origin, std::string_view fetchSite,
    std::string_view path, bool post, std::string_view token, std::string_view expectedToken) {
  if (!viaSetupWifi || (!origin.empty() && origin != "http://192.168.4.1") || fetchSite == "cross-site")
    return PortalAccess::forbidden;
  if (path == "/erase" || path == "/restart" || path == "/info" || path == "/param" || path == "/paramsave")
    return PortalAccess::unavailable;
  if (path == "/wifisave" && (!post || expectedToken.empty() || token != expectedToken))
    return PortalAccess::forbidden;
  return PortalAccess::allow;
}
}
