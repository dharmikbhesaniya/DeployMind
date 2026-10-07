export interface ParsedDocSection {
  title: string;
  content: string;
}

export interface ReadmeSemanticAnalysis {
  projectOverview: string;
  howItWorks: string;
  setupWorkflow: string[];
  sections: ParsedDocSection[];
  detectedBuildCommand?: string;
  detectedStartCommand?: string;
  detectedPort?: number;
  detectedMigrationCommand?: string;
}

export class DocParser {
  // Extract key setup, environment, and architecture sections from README and documentation
  extractRelevantSections(markdown: string): ParsedDocSection[] {
    const analysis = this.analyzeReadme(markdown);
    return analysis.sections;
  }

  // Deep semantic analysis of README to understand how project works and setup instructions
  analyzeReadme(markdown: string): ReadmeSemanticAnalysis {
    const lines = markdown.split('\n');
    const sections: ParsedDocSection[] = [];
    let currentTitle = 'Introduction';
    let currentContent: string[] = [];
    let projectOverview = '';
    let howItWorks = '';
    const setupWorkflow: string[] = [];

    const interestingKeywords = [
      'about',
      'overview',
      'architecture',
      'how it works',
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
      'production',
      'build',
      'start',
      'run',
      'deploy',
    ];

    for (const line of lines) {
      if (line.startsWith('#')) {
        if (currentContent.length > 0) {
          const joined = currentContent.join('\n').trim();
          const lowerTitle = currentTitle.toLowerCase();
          if (
            !projectOverview &&
            joined &&
            (lowerTitle.includes('overview') ||
              lowerTitle.includes('about') ||
              lowerTitle.includes('introduction') ||
              currentTitle === 'Introduction')
          ) {
            projectOverview = joined.slice(0, 500);
          }

          if (
            (lowerTitle.includes('how it works') ||
              lowerTitle.includes('architecture') ||
              lowerTitle.includes('workflow')) &&
            !howItWorks
          ) {
            howItWorks = joined.slice(0, 600);
          }

          if (
            lowerTitle.includes('setup') ||
            lowerTitle.includes('install') ||
            lowerTitle.includes('getting started') ||
            lowerTitle.includes('prerequisite')
          ) {
            // Extract setup bullet points or code snippets
            const steps = currentContent
              .filter((l) => l.trim().match(/^(\d+\.|\*|-|`)/))
              .map((l) => l.trim().replace(/^(\d+\.|\*|-)\s*/, ''))
              .filter((l) => l.length > 3 && l.length < 200);
            if (steps.length > 0 && setupWorkflow.length === 0) {
              setupWorkflow.push(...steps.slice(0, 6));
            }
          }

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

        currentTitle = line.replace(/^#+\s*/, '').trim();
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    if (currentContent.length > 0) {
      const joined = currentContent.join('\n').trim();
      const lowerTitle = currentTitle.toLowerCase();
      if (
        (!projectOverview && joined) &&
        (lowerTitle.includes('overview') || lowerTitle.includes('about') || lowerTitle.includes('introduction') || currentTitle === 'Introduction')
      ) {
        projectOverview = joined.slice(0, 500);
      }
      sections.push({
        title: currentTitle,
        content: joined.slice(0, 3000),
      });
    }

    const fullText = markdown.toLowerCase();

    // Detect production build command from README instructions (Never dev mode)
    let detectedBuildCommand: string | undefined;
    if (fullText.includes('npm run build') || fullText.includes('pnpm build') || fullText.includes('yarn build')) {
      detectedBuildCommand = 'npm run build';
    } else if (fullText.includes('cargo build --release')) {
      detectedBuildCommand = 'cargo build --release';
    } else if (fullText.includes('go build')) {
      detectedBuildCommand = 'go build -o server .';
    }

    // Detect production start command - strictly production (NEVER dev mode)
    let detectedStartCommand: string | undefined;
    if (fullText.includes('npm start') || fullText.includes('node dist/') || fullText.includes('node server.js')) {
      detectedStartCommand = 'npm start';
    } else if (fullText.includes('gunicorn') || (fullText.includes('uvicorn') && !fullText.includes('--reload'))) {
      detectedStartCommand = 'gunicorn -w 4 -k uvicorn.workers.UvicornWorker main:app';
    } else if (fullText.includes('python app.py') || fullText.includes('python main.py')) {
      detectedStartCommand = 'python app.py';
    } else if (fullText.includes('./server') || fullText.includes('./main')) {
      detectedStartCommand = './server';
    }

    // Detect port from text like "runs on port 8080" or "http://localhost:4000"
    let detectedPort: number | undefined;
    const portMatch = fullText.match(/(?:port|localhost:)\s*(\d{4,5})/);
    if (portMatch) {
      detectedPort = parseInt(portMatch[1], 10);
    }

    // Detect migration command
    let detectedMigrationCommand: string | undefined;
    if (fullText.includes('prisma migrate')) {
      detectedMigrationCommand = 'npx prisma migrate deploy';
    } else if (fullText.includes('alembic upgrade head')) {
      detectedMigrationCommand = 'alembic upgrade head';
    } else if (fullText.includes('drizzle-kit push') || fullText.includes('db:push')) {
      detectedMigrationCommand = 'npm run db:push';
    }

    return {
      projectOverview: projectOverview || 'Application service discovered from repository.',
      howItWorks: howItWorks || 'Autonomous lifecycle management with reverse proxy routing.',
      setupWorkflow: setupWorkflow.length > 0 ? setupWorkflow : ['Clone repository', 'Configure environment variables', 'Build production assets', 'Launch service'],
      sections,
      detectedBuildCommand,
      detectedStartCommand,
      detectedPort,
      detectedMigrationCommand,
    };
  }
}

export const docParser = new DocParser();
