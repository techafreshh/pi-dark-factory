import { useEffect } from "react";
import { Shell } from "@/components/shell";
import { Empty } from "@/components/ui";
import { useRoute } from "@/lib/router";
import { ActivityPage } from "@/pages/activity";
import { LapPage } from "@/pages/lap";
import { Overview } from "@/pages/overview";
import { LapsPage, ProjectPage, Projects } from "@/pages/projects";

export default function App() {
  const route = useRoute();
  const [section, arg] = route.parts;

  useEffect(() => {
    document.title = section ? `${arg ? arg + " · " : ""}${section} · pi-dark-factory` : "pi-dark-factory";
  }, [section, arg]);
  // a new page starts at the top; query changes (filters, paging) keep the scroll
  useEffect(() => {
    window.scrollTo(0, 0); // braces: Chrome returns a Promise here, which React would call as a cleanup
  }, [route.path]);

  let page: React.ReactNode;
  if (!section) page = <Overview />;
  else if (section === "projects" && arg) page = <ProjectPage key={arg} route={route} slug={decodeURIComponent(arg)} />;
  else if (section === "projects") page = <Projects route={route} />;
  else if (section === "laps" && arg && /^\d+$/.test(arg)) page = <LapPage key={arg} route={route} id={Number(arg)} />;
  else if (section === "laps") page = <LapsPage route={route} />;
  else if (section === "activity") page = <ActivityPage route={route} />;
  else page = <Empty>Nothing lives at {route.path}. <a className="text-info" href="#/">Go to the overview</a>.</Empty>;

  return <Shell path={route.path}>{page}</Shell>;
}
