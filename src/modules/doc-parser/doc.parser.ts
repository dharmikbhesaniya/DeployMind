export interface ParsedDocSection {
  title: string;
  content: string;
}

export class DocParser {
  // Extract key setup, environment, and architecture sections from README and documentation
  extractRelevantSections(markdown: string): ParsedDocSection[] {
    const lines = markdown.split('\n');
    const sections: ParsedDocSection[] = [];
    let currentTitle = 'Introduction';
    let currentContent: string[] = [];

    const interestingKeywords = [
      'env',
      'environment',
      'config',
      'setup',
      'install',
      'docker',
      'compose',
      'database',
      'postgres',
      'redis',
      'requirement',
      'prerequisite',
      'port',
      'migrate',
      'start',
      'deploy',
    ];

    for (const line of lines) {
      if (line.startsWith('#')) {
        // Save previous section if it had content and was interesting
        if (currentContent.length > 0) {
          const joined = currentContent.join('\n').trim();
          const isInteresting = interestingKeywords.some(
            (kw) =>
              currentTitle.toLowerCase().includes(kw) ||
              joined.toLowerCase().includes(kw)
          );

          if (isInteresting && joined.length > 0) {
            sections.push({
              title: currentTitle,
              content: joined.slice(0, 3000), // Cap each section to avoid prompt blowout
            });
          }
        }

        currentTitle = line.replace(/^#+\s*/, '').trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    // Save final section
    if (currentContent.length > 0) {
      const joined = currentContent.join('\n').trim();
      const isInteresting = interestingKeywords.some(
        (kw) =>
          currentTitle.toLowerCase().includes(kw) ||
          joined.toLowerCase().includes(kw)
      );

      if (isInteresting && joined.length > 0) {
        sections.push({
          title: currentTitle,
          content: joined.slice(0, 3000),
        });
      }
    }

    return sections;
  }
}

export const docParser = new DocParser();
