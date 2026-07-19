import { Sidebar } from "@/components/chat/Sidebar";
import { TitleBar } from "@/components/chat/TitleBar";
import { Composer } from "@/components/chat/Composer";
import { Thread } from "@/components/chat/Thread";
import { FIXTURE_CONVERSATION } from "@/lib/fixtures/conversation";

// The chat shell (mock 2a/1a). Renders a fixture conversation in 005 - guest sidebar (teaser),
// canvas title bar with the conversation title (AC-14), thread with one card per chart primitive, and
// the composer. 006 swaps the fixture for the live message store + streaming.
export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  await params; // the route id is the live source in 006; the fixture stands in for now.
  const convo = FIXTURE_CONVERSATION;

  return (
    <div className="app" style={{ height: "100vh" }}>
      <Sidebar activeTitle={convo.title} />
      <main className="main">
        <div className="canvas">
          <TitleBar title={convo.title} />
          <div className="thread-scroll">
            <Thread items={convo.items} />
          </div>
          <Composer state="default" />
        </div>
      </main>
    </div>
  );
}
