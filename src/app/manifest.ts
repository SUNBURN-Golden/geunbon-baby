import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "근본",
    short_name: "근본",
    description: "프리미엄 근본템 시세와 인스타 공구",
    start_url: "/",
    display: "standalone",
    background_color: "#f3efe6",
    theme_color: "#1c3a32",
    lang: "ko",
  };
}
